//! Conservative ANSI transition encoder.

use std::fmt::Write as _;
use std::sync::Arc;

use pocket_tui_core::{Color, FrameArtifact, Row, TextAttributes};
use thiserror::Error;

use crate::capability::{ColorCapability, EffectBusCapability, TerminalCapabilities};
use crate::state::{
    CursorShape, CursorState, EffectBusState, PaintCell, PaintColor, PaintStyle, PhysicalState,
    ScreenModel,
};

const EFFECT_BUS_SIGNATURE: [u8; 3] = *b"PTX";
const EFFECT_BUS_FIRST_SLOT: u8 = 240;
const RESET_EFFECT_BUS: &[u8] = b"\x1b]104;240;241;242;243\x1b\\";
const EFFECT_CURSOR_SHADE_A: Color = Color::Rgb(41, 184, 219);
const EFFECT_CURSOR_SHADE_B: Color = Color::Rgb(42, 184, 219);

/// A frame could not be represented safely on a terminal grid.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum EncodeError {
    #[error("frame row {row} is missing")]
    MissingRow { row: u16 },
    #[error("frame row {row} has {actual} cells, expected {expected}")]
    InvalidRowWidth {
        row: u16,
        expected: usize,
        actual: usize,
    },
    #[error("cell references missing grapheme ID {id}")]
    MissingGrapheme { id: u32 },
    #[error("cell references missing style ID {id}")]
    MissingStyle { id: u32 },
    #[error("grapheme at row {row}, column {column} has inconsistent width")]
    InvalidGraphemeWidth { row: u16, column: u16 },
    #[error("continuation at row {row}, column {column} has no valid lead cell")]
    InvalidContinuation { row: u16, column: u16 },
}

pub(crate) struct EncodedTransition {
    pub(crate) bytes: Vec<u8>,
    pub(crate) predicted: PhysicalState,
}

pub(crate) fn resolve_frame(frame: &FrameArtifact) -> Result<ScreenModel, EncodeError> {
    let size = frame.screen.size();
    let mut rows = Vec::with_capacity(size.rows as usize);
    for row_index in 0..size.rows {
        let row = frame
            .screen
            .row(Row(row_index))
            .ok_or(EncodeError::MissingRow { row: row_index })?;
        if row.cells().len() != size.columns as usize {
            return Err(EncodeError::InvalidRowWidth {
                row: row_index,
                expected: size.columns as usize,
                actual: row.cells().len(),
            });
        }

        let mut cells = Vec::with_capacity(size.columns as usize);
        for (column, cell) in row.cells().iter().copied().enumerate() {
            let style = frame
                .resources
                .style(cell.style())
                .ok_or(EncodeError::MissingStyle { id: cell.style().0 })?;
            let style = PaintStyle {
                foreground: convert_color(style.foreground),
                background: convert_color(style.background),
                bold: style.attributes.contains(TextAttributes::BOLD),
                dim: style.attributes.contains(TextAttributes::DIM),
                italic: style.attributes.contains(TextAttributes::ITALIC),
                underline: style.attributes.contains(TextAttributes::UNDERLINE),
                blink: style.attributes.contains(TextAttributes::BLINK),
                inverse: style.attributes.contains(TextAttributes::REVERSE),
                hidden: style.attributes.contains(TextAttributes::HIDDEN),
                strikethrough: style.attributes.contains(TextAttributes::STRIKE),
            };

            if cell.is_continuation() {
                let lead_offset = cell.lead_offset();
                let lead_column = column.checked_sub(lead_offset as usize).ok_or(
                    EncodeError::InvalidContinuation {
                        row: row_index,
                        column: column as u16,
                    },
                )?;
                let lead = row.cells()[lead_column];
                if lead.is_continuation()
                    || lead.display_width() <= lead_offset
                    || lead.style() != cell.style()
                    || lead.grapheme() != cell.grapheme()
                {
                    return Err(EncodeError::InvalidContinuation {
                        row: row_index,
                        column: column as u16,
                    });
                }
                cells.push(PaintCell {
                    text: Arc::from(""),
                    width: 0,
                    lead_offset,
                    style,
                });
                continue;
            }

            let grapheme =
                frame
                    .resources
                    .grapheme(cell.grapheme())
                    .ok_or(EncodeError::MissingGrapheme {
                        id: cell.grapheme().0,
                    })?;
            let width = cell.display_width();
            if width == 0
                || width != grapheme.width()
                || column.saturating_add(width as usize) > size.columns as usize
            {
                return Err(EncodeError::InvalidGraphemeWidth {
                    row: row_index,
                    column: column as u16,
                });
            }
            cells.push(PaintCell {
                text: sanitize_grapheme(grapheme.as_str()),
                width,
                lead_offset: 0,
                style,
            });
        }
        rows.push(cells);
    }

    Ok(ScreenModel {
        generation: frame.generation.0,
        columns: size.columns,
        rows,
    })
}

pub(crate) fn encode_transition(
    confirmed: &PhysicalState,
    target: Arc<ScreenModel>,
    cursor: CursorState,
    effect_bus: EffectBusState,
    capabilities: TerminalCapabilities,
) -> EncodedTransition {
    let (mut cursor, effect_bus) = normalize_effect_presentation(cursor, effect_bus, capabilities);
    cursor.row = cursor.row.min(target.rows.len().saturating_sub(1) as u16);
    cursor.column = cursor.column.min(target.columns.saturating_sub(1));
    let mut screen_bytes = Vec::new();
    match confirmed.screen() {
        Some(old)
            if old.columns == target.columns
                && old.rows.len() == target.rows.len()
                && old.generation != 0 =>
        {
            encode_row_diff(&mut screen_bytes, old, &target, capabilities);
        }
        _ => encode_full_repaint(&mut screen_bytes, &target, capabilities),
    }

    let confirmed_cursor = confirmed.cursor();
    let screen_changed = !screen_bytes.is_empty();
    let mut bytes = Vec::with_capacity(screen_bytes.len().saturating_add(160));
    if screen_changed && confirmed_cursor.visible {
        // Painting uses cursor-positioning commands internally. Hide the real
        // cursor before the first byte so a partial write cannot expose those
        // intermediate locations as the semantic player/shader anchor.
        bytes.extend_from_slice(b"\x1b[?25l");
    }
    encode_effect_bus(&mut bytes, confirmed.effect_bus(), effect_bus);
    bytes.extend_from_slice(&screen_bytes);
    if screen_changed {
        bytes.extend_from_slice(b"\x1b[0m");
    }
    if screen_changed && confirmed_cursor.visible {
        // Re-establish the previous semantic anchor while still hidden before
        // moving to the new one. This keeps cursor-history consumers stable.
        move_cursor(
            &mut bytes,
            confirmed_cursor.row as usize,
            confirmed_cursor.column as usize,
        );
    }
    if screen_changed || confirmed_cursor != cursor {
        encode_cursor(
            &mut bytes,
            cursor,
            confirmed_cursor.color != cursor.color,
            confirmed_cursor.shape != cursor.shape || !confirmed_cursor.visible,
        );
    }
    EncodedTransition {
        bytes,
        predicted: PhysicalState::for_screen(target, cursor, effect_bus),
    }
}

pub(crate) fn normalize_effect_presentation(
    mut cursor: CursorState,
    effect_bus: EffectBusState,
    capabilities: TerminalCapabilities,
) -> (CursorState, EffectBusState) {
    if capabilities.effect_bus != EffectBusCapability::GhosttyPaletteV1 {
        return (cursor, EffectBusState::default());
    }
    if effect_bus.enabled {
        cursor.color = if effect_bus.cursor_shade {
            EFFECT_CURSOR_SHADE_B
        } else {
            EFFECT_CURSOR_SHADE_A
        };
    }
    (cursor, effect_bus)
}

fn encode_effect_bus(output: &mut Vec<u8>, confirmed: EffectBusState, target: EffectBusState) {
    if confirmed.enabled && !target.enabled {
        output.extend_from_slice(RESET_EFFECT_BUS);
        return;
    }
    if !target.enabled {
        return;
    }

    let mut changed = Vec::with_capacity(4);
    if !confirmed.enabled {
        changed.push((EFFECT_BUS_FIRST_SLOT, EFFECT_BUS_SIGNATURE));
        for (index, channel) in target.channels.into_iter().enumerate() {
            changed.push((EFFECT_BUS_FIRST_SLOT + 1 + index as u8, channel));
        }
    } else {
        for (index, channel) in target.channels.into_iter().enumerate() {
            if confirmed.channels[index] != channel {
                changed.push((EFFECT_BUS_FIRST_SLOT + 1 + index as u8, channel));
            }
        }
    }
    if changed.is_empty() {
        return;
    }

    output.extend_from_slice(b"\x1b]4");
    for (slot, [red, green, blue]) in changed {
        let _ = write!(
            output_string(output),
            ";{slot};#{red:02x}{green:02x}{blue:02x}"
        );
    }
    output.extend_from_slice(b"\x1b\\");
}

fn encode_cursor(
    output: &mut Vec<u8>,
    cursor: CursorState,
    color_changed: bool,
    shape_changed: bool,
) {
    if color_changed {
        match cursor.color {
            Color::Default => output.extend_from_slice(b"\x1b]112\x1b\\"),
            color => {
                let (red, green, blue) = cursor_rgb(color);
                let _ = write!(
                    output_string(output),
                    "\x1b]12;#{red:02x}{green:02x}{blue:02x}\x1b\\"
                );
            }
        }
    }
    if cursor.visible {
        if shape_changed {
            output.extend_from_slice(match cursor.shape {
                CursorShape::Block => b"\x1b[2 q",
                CursorShape::Underline => b"\x1b[4 q",
                CursorShape::Bar => b"\x1b[6 q",
            });
        }
        move_cursor(output, cursor.row as usize, cursor.column as usize);
        output.extend_from_slice(b"\x1b[?25h");
    } else {
        output.extend_from_slice(b"\x1b[?25l\x1b[H");
    }
}

fn cursor_rgb(color: Color) -> (u8, u8, u8) {
    match color {
        Color::Default => (255, 255, 255),
        Color::Rgb(red, green, blue) => (red, green, blue),
        Color::Indexed(index) => xterm_index_rgb(index),
    }
}

fn xterm_index_rgb(index: u8) -> (u8, u8, u8) {
    const ANSI: [(u8, u8, u8); 16] = [
        (0, 0, 0),
        (205, 49, 49),
        (13, 188, 121),
        (229, 229, 16),
        (36, 114, 200),
        (188, 63, 188),
        (17, 168, 205),
        (229, 229, 229),
        (102, 102, 102),
        (241, 76, 76),
        (35, 209, 139),
        (245, 245, 67),
        (59, 142, 234),
        (214, 112, 214),
        (41, 184, 219),
        (255, 255, 255),
    ];
    if index < 16 {
        return ANSI[index as usize];
    }
    if index < 232 {
        let value = index - 16;
        let component = |step: u8| if step == 0 { 0 } else { 55 + step * 40 };
        return (
            component(value / 36),
            component((value / 6) % 6),
            component(value % 6),
        );
    }
    let gray = 8 + (index - 232) * 10;
    (gray, gray, gray)
}

fn encode_full_repaint(
    output: &mut Vec<u8>,
    target: &ScreenModel,
    capabilities: TerminalCapabilities,
) {
    output.extend_from_slice(b"\x1b[?25l\x1b[0m\x1b[2J");
    for (row_index, row) in target.rows.iter().enumerate() {
        move_cursor(output, row_index, 0);
        if capabilities.erase_in_line && row.iter().all(PaintCell::is_default_blank) {
            output.extend_from_slice(b"\x1b[0m\x1b[K");
            continue;
        }

        let end = if capabilities.erase_in_line {
            row.iter()
                .rposition(|cell| !cell.is_default_blank())
                .map_or(0, |index| index + 1)
        } else {
            row.len()
        };
        if end > 0 {
            encode_cells(output, &row[..end], capabilities);
        }
        if capabilities.erase_in_line && end < row.len() {
            output.extend_from_slice(b"\x1b[0m\x1b[K");
        }
    }
}

fn encode_row_diff(
    output: &mut Vec<u8>,
    old: &ScreenModel,
    target: &ScreenModel,
    capabilities: TerminalCapabilities,
) {
    for (row_index, (old_row, new_row)) in old.rows.iter().zip(&target.rows).enumerate() {
        let Some(mut start) = old_row
            .iter()
            .zip(new_row)
            .position(|(old, new)| old != new)
        else {
            continue;
        };
        let mut end = old_row
            .iter()
            .zip(new_row)
            .rposition(|(old, new)| old != new)
            .map_or(start + 1, |index| index + 1);
        expand_grapheme_span(old_row, &mut start, &mut end);
        expand_grapheme_span(new_row, &mut start, &mut end);

        move_cursor(output, row_index, start);
        if capabilities.erase_in_line && new_row[start..].iter().all(PaintCell::is_default_blank) {
            output.extend_from_slice(b"\x1b[0m\x1b[K");
        } else {
            encode_cells(output, &new_row[start..end], capabilities);
        }
    }
}

fn expand_grapheme_span(row: &[PaintCell], start: &mut usize, end: &mut usize) {
    if let Some(cell) = row.get(*start)
        && cell.width == 0
    {
        *start = start.saturating_sub(cell.lead_offset as usize);
    }

    loop {
        let mut expanded = *end;
        for (offset, cell) in row[*start..(*end).min(row.len())].iter().enumerate() {
            if cell.width > 0 {
                expanded = expanded.max(*start + offset + cell.width as usize);
            }
        }
        expanded = expanded.min(row.len());
        if expanded == *end {
            break;
        }
        *end = expanded;
    }
}

fn encode_cells(output: &mut Vec<u8>, cells: &[PaintCell], capabilities: TerminalCapabilities) {
    let mut current_style = None;
    for cell in cells {
        if cell.width == 0 {
            continue;
        }
        if current_style != Some(cell.style) {
            encode_style(output, cell.style, capabilities.color);
            current_style = Some(cell.style);
        }
        output.extend_from_slice(cell.text.as_bytes());
    }
}

fn encode_style(output: &mut Vec<u8>, style: PaintStyle, colors: ColorCapability) {
    let mut parameters = String::from("0");
    for (enabled, code) in [
        (style.bold, 1),
        (style.dim, 2),
        (style.italic, 3),
        (style.underline, 4),
        (style.blink, 5),
        (style.inverse, 7),
        (style.hidden, 8),
        (style.strikethrough, 9),
    ] {
        if enabled {
            let _ = write!(parameters, ";{code}");
        }
    }
    encode_color_parameter(&mut parameters, style.foreground, colors, true);
    encode_color_parameter(&mut parameters, style.background, colors, false);
    let _ = write!(output_string(output), "\x1b[{parameters}m");
}

fn encode_color_parameter(
    parameters: &mut String,
    color: PaintColor,
    capabilities: ColorCapability,
    foreground: bool,
) {
    let prefix = if foreground { 38 } else { 48 };
    match (capabilities, color) {
        (_, PaintColor::Default) | (ColorCapability::None, _) => {}
        (ColorCapability::Ansi16, PaintColor::Indexed(index)) if index < 8 => {
            let base = if foreground { 30 } else { 40 };
            let _ = write!(parameters, ";{}", base + index);
        }
        (ColorCapability::Ansi16, PaintColor::Indexed(index)) if index < 16 => {
            let base = if foreground { 90 } else { 100 };
            let _ = write!(parameters, ";{}", base + index - 8);
        }
        (ColorCapability::Ansi16, _) => {}
        (ColorCapability::Ansi256, PaintColor::Indexed(index)) => {
            let _ = write!(parameters, ";{prefix};5;{index}");
        }
        (ColorCapability::Ansi256, PaintColor::Rgb(red, green, blue)) => {
            let index = rgb_to_ansi256(red, green, blue);
            let _ = write!(parameters, ";{prefix};5;{index}");
        }
        (ColorCapability::TrueColor, PaintColor::Indexed(index)) => {
            let _ = write!(parameters, ";{prefix};5;{index}");
        }
        (ColorCapability::TrueColor, PaintColor::Rgb(red, green, blue)) => {
            let _ = write!(parameters, ";{prefix};2;{red};{green};{blue}");
        }
    }
}

fn move_cursor(output: &mut Vec<u8>, row: usize, column: usize) {
    let _ = write!(output_string(output), "\x1b[{};{}H", row + 1, column + 1);
}

fn convert_color(color: Color) -> PaintColor {
    match color {
        Color::Default => PaintColor::Default,
        Color::Indexed(index) => PaintColor::Indexed(index),
        Color::Rgb(red, green, blue) => PaintColor::Rgb(red, green, blue),
    }
}

fn sanitize_grapheme(text: &str) -> Arc<str> {
    if text.chars().all(|character| !character.is_control()) {
        return Arc::from(text);
    }
    Arc::from(
        text.chars()
            .map(|character| {
                if character.is_control() {
                    '\u{fffd}'
                } else {
                    character
                }
            })
            .collect::<String>(),
    )
}

fn rgb_to_ansi256(red: u8, green: u8, blue: u8) -> u8 {
    let quantize = |component: u8| ((component as u16 * 5 + 127) / 255) as u8;
    16 + 36 * quantize(red) + 6 * quantize(green) + quantize(blue)
}

/// Small adapter allowing `write!` to append formatted ASCII to a byte buffer.
fn output_string(output: &mut Vec<u8>) -> ByteWriter<'_> {
    ByteWriter(output)
}

struct ByteWriter<'a>(&'a mut Vec<u8>);

impl std::fmt::Write for ByteWriter<'_> {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        self.0.extend_from_slice(value.as_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(text: &str, width: u8, lead_offset: u8) -> PaintCell {
        PaintCell {
            text: Arc::from(text),
            width,
            lead_offset,
            style: PaintStyle::default(),
        }
    }

    #[test]
    fn replacing_a_wide_cell_clears_its_old_trailing_column() {
        let old = Arc::new(ScreenModel {
            generation: 1,
            columns: 3,
            rows: vec![vec![cell("界", 2, 0), cell("", 0, 1), cell("z", 1, 0)]],
        });
        let target = Arc::new(ScreenModel {
            generation: 2,
            columns: 3,
            rows: vec![vec![cell("x", 1, 0), cell(" ", 1, 0), cell("z", 1, 0)]],
        });
        let confirmed =
            PhysicalState::for_screen(old, CursorState::default(), EffectBusState::default());

        let transition = encode_transition(
            &confirmed,
            target,
            CursorState::default(),
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );
        let encoded = String::from_utf8(transition.bytes).unwrap();

        assert!(encoded.contains("\x1b[1;1H\x1b[0mx "));
        assert_eq!(transition.predicted.generation(), 2);
    }

    #[test]
    fn visible_cursor_is_a_final_shader_anchor_without_retriggering_equal_color() {
        let old = Arc::new(ScreenModel {
            generation: 1,
            columns: 5,
            rows: vec![vec![cell(" ", 1, 0); 5]; 3],
        });
        let target = Arc::new(ScreenModel {
            generation: 2,
            columns: 5,
            rows: vec![vec![cell(" ", 1, 0); 5]; 3],
        });
        let confirmed =
            PhysicalState::for_screen(old, CursorState::default(), EffectBusState::default());
        let cursor = CursorState {
            row: 2,
            column: 3,
            visible: true,
            shape: CursorShape::Block,
            color: Color::Rgb(241, 76, 76),
        };

        let transition = encode_transition(
            &confirmed,
            target,
            cursor,
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );
        assert_eq!(
            transition.bytes,
            b"\x1b]12;#f14c4c\x1b\\\x1b[2 q\x1b[3;4H\x1b[?25h"
        );

        let unchanged = Arc::new(ScreenModel {
            generation: 3,
            columns: 5,
            rows: vec![vec![cell(" ", 1, 0); 5]; 3],
        });
        let next = encode_transition(
            &transition.predicted,
            unchanged,
            cursor,
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );
        assert!(next.bytes.is_empty());
    }

    #[test]
    fn dirty_screen_hides_and_restores_visible_anchor_before_final_cursor() {
        let old = Arc::new(ScreenModel {
            generation: 1,
            columns: 3,
            rows: vec![vec![cell("a", 1, 0), cell(" ", 1, 0), cell(" ", 1, 0)]],
        });
        let target = Arc::new(ScreenModel {
            generation: 2,
            columns: 3,
            rows: vec![vec![cell("b", 1, 0), cell(" ", 1, 0), cell(" ", 1, 0)]],
        });
        let previous = CursorState {
            row: 0,
            column: 2,
            visible: true,
            shape: CursorShape::Block,
            color: Color::Default,
        };
        let confirmed = PhysicalState::for_screen(old, previous, EffectBusState::default());
        let next = CursorState {
            column: 1,
            ..previous
        };

        let transition = encode_transition(
            &confirmed,
            target,
            next,
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );

        assert!(transition.bytes.starts_with(b"\x1b[?25l"));
        assert!(transition.bytes.ends_with(b"\x1b[1;3H\x1b[1;2H\x1b[?25h"));
    }

    #[test]
    fn cursor_shape_uses_steady_decscusr_and_only_repeats_when_needed() {
        let screen = |generation| {
            Arc::new(ScreenModel {
                generation,
                columns: 2,
                rows: vec![vec![cell(" ", 1, 0); 2]],
            })
        };
        let confirmed =
            PhysicalState::for_screen(screen(1), CursorState::default(), EffectBusState::default());
        let underline = CursorState {
            row: 0,
            column: 0,
            visible: true,
            shape: CursorShape::Underline,
            color: Color::Default,
        };
        let first = encode_transition(
            &confirmed,
            screen(2),
            underline,
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );
        assert_eq!(first.bytes, b"\x1b[4 q\x1b[1;1H\x1b[?25h");

        let moved = CursorState {
            column: 1,
            ..underline
        };
        let second = encode_transition(
            &first.predicted,
            screen(3),
            moved,
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );
        assert_eq!(second.bytes, b"\x1b[1;2H\x1b[?25h");

        let bar = CursorState {
            shape: CursorShape::Bar,
            ..moved
        };
        let third = encode_transition(
            &second.predicted,
            screen(4),
            bar,
            EffectBusState::default(),
            TerminalCapabilities::conservative(),
        );
        assert_eq!(third.bytes, b"\x1b[6 q\x1b[1;2H\x1b[?25h");
    }

    #[test]
    fn ghostty_effect_bus_installs_diffs_and_resets_reserved_slots() {
        let screen = |generation| {
            Arc::new(ScreenModel {
                generation,
                columns: 2,
                rows: vec![vec![cell(" ", 1, 0); 2]],
            })
        };
        let confirmed =
            PhysicalState::for_screen(screen(1), CursorState::default(), EffectBusState::default());
        let cursor = CursorState {
            row: 0,
            column: 1,
            visible: true,
            shape: CursorShape::Block,
            color: Color::Default,
        };
        let installed_bus = EffectBusState {
            enabled: true,
            channels: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
            cursor_shade: false,
        };
        let installed = encode_transition(
            &confirmed,
            screen(2),
            cursor,
            installed_bus,
            TerminalCapabilities::ghostty(),
        );
        assert_eq!(
            installed.bytes,
            b"\x1b]4;240;#505458;241;#010203;242;#040506;243;#070809\x1b\\\x1b]12;#29b8db\x1b\\\x1b[2 q\x1b[1;2H\x1b[?25h"
        );

        let updated_bus = EffectBusState {
            channels: [[1, 2, 3], [10, 11, 12], [7, 8, 9]],
            cursor_shade: true,
            ..installed_bus
        };
        let updated = encode_transition(
            &installed.predicted,
            screen(3),
            cursor,
            updated_bus,
            TerminalCapabilities::ghostty(),
        );
        assert_eq!(
            updated.bytes,
            b"\x1b]4;242;#0a0b0c\x1b\\\x1b]12;#2ab8db\x1b\\\x1b[1;2H\x1b[?25h"
        );

        let disabled = encode_transition(
            &updated.predicted,
            screen(4),
            cursor,
            EffectBusState::default(),
            TerminalCapabilities::ghostty(),
        );
        assert_eq!(
            disabled.bytes,
            b"\x1b]104;240;241;242;243\x1b\\\x1b]112\x1b\\\x1b[1;2H\x1b[?25h"
        );
    }

    #[test]
    fn ordinary_profiles_emit_no_effect_bus_osc() {
        let old = Arc::new(ScreenModel {
            generation: 1,
            columns: 1,
            rows: vec![vec![cell(" ", 1, 0)]],
        });
        let target = Arc::new(ScreenModel {
            generation: 2,
            columns: 1,
            rows: vec![vec![cell(" ", 1, 0)]],
        });
        let confirmed =
            PhysicalState::for_screen(old, CursorState::default(), EffectBusState::default());
        for capabilities in [
            TerminalCapabilities::conservative(),
            TerminalCapabilities::rich(),
        ] {
            let transition = encode_transition(
                &confirmed,
                Arc::clone(&target),
                CursorState::default(),
                EffectBusState {
                    enabled: true,
                    channels: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
                    cursor_shade: true,
                },
                capabilities,
            );

            assert!(transition.bytes.is_empty());
            assert_eq!(transition.predicted.effect_bus(), EffectBusState::default());
        }
    }
}
