//! Conservative ANSI transition encoder.

use std::fmt::Write as _;
use std::sync::Arc;

use pocket_tui_core::{Color, FrameArtifact, Row, TextAttributes};
use thiserror::Error;

use crate::capability::{ColorCapability, TerminalCapabilities};
use crate::state::{PaintCell, PaintColor, PaintStyle, PhysicalState, ScreenModel};

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
    capabilities: TerminalCapabilities,
) -> EncodedTransition {
    let mut bytes = Vec::new();
    match confirmed.screen() {
        Some(old)
            if old.columns == target.columns
                && old.rows.len() == target.rows.len()
                && old.generation != 0 =>
        {
            encode_row_diff(&mut bytes, old, &target, capabilities);
        }
        _ => encode_full_repaint(&mut bytes, &target, capabilities),
    }

    if !bytes.is_empty() {
        bytes.extend_from_slice(b"\x1b[0m\x1b[H");
    }
    EncodedTransition {
        bytes,
        predicted: PhysicalState::for_screen(target),
    }
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
        let confirmed = PhysicalState::for_screen(old);

        let transition =
            encode_transition(&confirmed, target, TerminalCapabilities::conservative());
        let encoded = String::from_utf8(transition.bytes).unwrap();

        assert!(encoded.contains("\x1b[1;1H\x1b[0mx "));
        assert_eq!(transition.predicted.generation(), 2);
    }
}
