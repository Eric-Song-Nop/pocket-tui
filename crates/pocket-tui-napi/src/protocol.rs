//! PTX1: the small, pointer-free mutation protocol used by the JS MVP.

use std::fmt;

pub const MAGIC: [u8; 4] = *b"PTX1";
pub const MAJOR_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 24;
pub const OP_HEADER_LEN: usize = 8;
pub const MAX_PACKET_LEN: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum Opcode {
    CreateBox = 1,
    CreateText = 2,
    AppendChild = 3,
    SetRoot = 4,
    SetText = 5,
    AppendText = 6,
    RemoveNode = 7,
    CreateTranscript = 8,
    OpenBlock = 9,
    AppendBlockText = 10,
    SealBlock = 11,
    CreateVirtualTranscript = 12,
    CreateCanvas = 13,
    SetCanvasFrame = 14,
    SetCursor = 15,
    SetEffectBus = 16,
}

impl TryFrom<u16> for Opcode {
    type Error = DecodeError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::CreateBox),
            2 => Ok(Self::CreateText),
            3 => Ok(Self::AppendChild),
            4 => Ok(Self::SetRoot),
            5 => Ok(Self::SetText),
            6 => Ok(Self::AppendText),
            7 => Ok(Self::RemoveNode),
            8 => Ok(Self::CreateTranscript),
            9 => Ok(Self::OpenBlock),
            10 => Ok(Self::AppendBlockText),
            11 => Ok(Self::SealBlock),
            12 => Ok(Self::CreateVirtualTranscript),
            13 => Ok(Self::CreateCanvas),
            14 => Ok(Self::SetCanvasFrame),
            15 => Ok(Self::SetCursor),
            16 => Ok(Self::SetEffectBus),
            _ => Err(DecodeError::new(format!("unknown required opcode {value}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Column,
    Row,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorSpec {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CursorShape {
    #[default]
    Block,
    Underline,
    Bar,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectBusProfile {
    GhosttyPaletteV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CanvasRun<'a> {
    pub row: u16,
    pub column: u16,
    pub attributes: u16,
    pub foreground: ColorSpec,
    pub background: ColorSpec,
    pub text: &'a str,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Operation<'a> {
    CreateBox {
        handle: u64,
        direction: Direction,
        border: bool,
        padding: u16,
    },
    CreateText {
        handle: u64,
        text: &'a str,
    },
    AppendChild {
        parent: u64,
        child: u64,
    },
    SetRoot {
        handle: u64,
    },
    SetText {
        handle: u64,
        text: &'a str,
    },
    AppendText {
        handle: u64,
        text: &'a str,
    },
    RemoveNode {
        handle: u64,
    },
    CreateTranscript {
        handle: u64,
    },
    OpenBlock {
        transcript: u64,
        block: u64,
    },
    AppendBlockText {
        block: u64,
        text: &'a str,
    },
    SealBlock {
        block: u64,
    },
    CreateVirtualTranscript {
        handle: u64,
        transcript: u64,
    },
    CreateCanvas {
        handle: u64,
    },
    SetCanvasFrame {
        handle: u64,
        width: u16,
        height: u16,
        runs: Vec<CanvasRun<'a>>,
    },
    SetCursor {
        row: u16,
        column: u16,
        visible: bool,
        shape: CursorShape,
        color: ColorSpec,
    },
    SetEffectBus {
        profile: EffectBusProfile,
        enabled: bool,
        trigger: bool,
        channels: [[u8; 3]; 3],
    },
}

#[derive(Debug, Eq, PartialEq)]
pub struct Packet<'a> {
    pub flags: u16,
    pub sequence: u64,
    pub operations: Vec<Operation<'a>>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct DecodeError {
    message: String,
}

impl DecodeError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DecodeError {}

pub fn decode(bytes: &[u8]) -> Result<Packet<'_>, DecodeError> {
    if bytes.len() < HEADER_LEN {
        return Err(DecodeError::new("PTX1 packet is shorter than its header"));
    }
    if bytes.len() > MAX_PACKET_LEN {
        return Err(DecodeError::new("PTX1 packet exceeds the 8 MiB limit"));
    }
    if bytes[0..4] != MAGIC {
        return Err(DecodeError::new("invalid PTX1 magic"));
    }

    let major = read_u16(bytes, 4)?;
    if major != MAJOR_VERSION {
        return Err(DecodeError::new(format!(
            "unsupported PTX major version {major}"
        )));
    }
    let flags = read_u16(bytes, 6)?;
    let declared_len = read_u32(bytes, 8)? as usize;
    let op_count = read_u32(bytes, 12)? as usize;
    let sequence = read_u64(bytes, 16)?;

    if declared_len != bytes.len() {
        return Err(DecodeError::new(format!(
            "PTX1 length mismatch: header says {declared_len}, received {}",
            bytes.len()
        )));
    }
    if op_count > (bytes.len() - HEADER_LEN) / OP_HEADER_LEN {
        return Err(DecodeError::new("impossible PTX1 operation count"));
    }

    let mut offset = HEADER_LEN;
    let mut operations = Vec::with_capacity(op_count);
    for _ in 0..op_count {
        let op_start = offset;
        let opcode = Opcode::try_from(read_u16(bytes, op_start)?)?;
        let _op_flags = read_u16(bytes, op_start + 2)?;
        let record_len = read_u32(bytes, op_start + 4)? as usize;
        if record_len < OP_HEADER_LEN || record_len % 8 != 0 {
            return Err(DecodeError::new("PTX1 record is not 8-byte aligned"));
        }
        let op_end = op_start
            .checked_add(record_len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| DecodeError::new("PTX1 record exceeds packet bounds"))?;
        let payload = &bytes[op_start + OP_HEADER_LEN..op_end];
        operations.push(decode_operation(opcode, payload)?);
        offset = op_end;
    }

    if offset != bytes.len() {
        return Err(DecodeError::new("trailing bytes after final PTX1 record"));
    }

    Ok(Packet {
        flags,
        sequence,
        operations,
    })
}

fn decode_operation(opcode: Opcode, payload: &[u8]) -> Result<Operation<'_>, DecodeError> {
    match opcode {
        Opcode::CreateBox => {
            require_payload(payload, 16)?;
            let direction = match payload[8] {
                0 => Direction::Column,
                1 => Direction::Row,
                value => return Err(DecodeError::new(format!("invalid box direction {value}"))),
            };
            match payload[9] {
                0 | 1 => {}
                value => return Err(DecodeError::new(format!("invalid border flag {value}"))),
            }
            Ok(Operation::CreateBox {
                handle: read_u64(payload, 0)?,
                direction,
                border: payload[9] != 0,
                padding: read_u16(payload, 10)?,
            })
        }
        Opcode::CreateText => decode_text_operation(payload, |handle, text| {
            Operation::CreateText { handle, text }
        }),
        Opcode::AppendChild => {
            require_payload(payload, 16)?;
            Ok(Operation::AppendChild {
                parent: read_u64(payload, 0)?,
                child: read_u64(payload, 8)?,
            })
        }
        Opcode::SetRoot => {
            require_payload(payload, 8)?;
            Ok(Operation::SetRoot {
                handle: read_u64(payload, 0)?,
            })
        }
        Opcode::SetText => {
            decode_text_operation(payload, |handle, text| Operation::SetText { handle, text })
        }
        Opcode::AppendText => decode_text_operation(payload, |handle, text| {
            Operation::AppendText { handle, text }
        }),
        Opcode::RemoveNode => {
            require_payload(payload, 8)?;
            Ok(Operation::RemoveNode {
                handle: read_u64(payload, 0)?,
            })
        }
        Opcode::CreateTranscript => {
            require_payload(payload, 8)?;
            Ok(Operation::CreateTranscript {
                handle: read_u64(payload, 0)?,
            })
        }
        Opcode::OpenBlock => {
            require_payload(payload, 16)?;
            Ok(Operation::OpenBlock {
                transcript: read_u64(payload, 0)?,
                block: read_u64(payload, 8)?,
            })
        }
        Opcode::AppendBlockText => decode_text_operation(payload, |block, text| {
            Operation::AppendBlockText { block, text }
        }),
        Opcode::SealBlock => {
            require_payload(payload, 8)?;
            Ok(Operation::SealBlock {
                block: read_u64(payload, 0)?,
            })
        }
        Opcode::CreateVirtualTranscript => {
            require_payload(payload, 16)?;
            Ok(Operation::CreateVirtualTranscript {
                handle: read_u64(payload, 0)?,
                transcript: read_u64(payload, 8)?,
            })
        }
        Opcode::CreateCanvas => {
            require_payload(payload, 8)?;
            Ok(Operation::CreateCanvas {
                handle: read_u64(payload, 0)?,
            })
        }
        Opcode::SetCanvasFrame => decode_canvas_frame(payload),
        Opcode::SetCursor => {
            require_payload(payload, 16)?;
            let visible = match payload[4] {
                0 => false,
                1 => true,
                value => {
                    return Err(DecodeError::new(format!(
                        "invalid cursor visibility flag {value}"
                    )));
                }
            };
            let shape = match payload[5] {
                0 => CursorShape::Block,
                1 => CursorShape::Underline,
                2 => CursorShape::Bar,
                value => {
                    return Err(DecodeError::new(format!("invalid cursor shape {value}")));
                }
            };
            if payload[6..8].iter().any(|byte| *byte != 0)
                || payload[12..].iter().any(|byte| *byte != 0)
            {
                return Err(DecodeError::new("non-zero SetCursor padding"));
            }
            Ok(Operation::SetCursor {
                row: read_u16(payload, 0)?,
                column: read_u16(payload, 2)?,
                visible,
                shape,
                color: decode_color(read_u32(payload, 8)?)?,
            })
        }
        Opcode::SetEffectBus => {
            if payload.len() != 16 {
                return Err(DecodeError::new(
                    "SetEffectBus payload must be exactly 16 bytes",
                ));
            }
            let profile = match payload[0] {
                1 => EffectBusProfile::GhosttyPaletteV1,
                _ => return Err(DecodeError::new("unsupported effect bus profile")),
            };
            let flags = payload[1];
            if flags & !0x03 != 0 {
                return Err(DecodeError::new("unknown required effect bus flag"));
            }
            if payload[2..4].iter().any(|byte| *byte != 0)
                || payload[13..16].iter().any(|byte| *byte != 0)
            {
                return Err(DecodeError::new("non-zero SetEffectBus padding"));
            }
            Ok(Operation::SetEffectBus {
                profile,
                enabled: flags & 1 != 0,
                trigger: flags & 2 != 0,
                channels: [
                    [payload[4], payload[5], payload[6]],
                    [payload[7], payload[8], payload[9]],
                    [payload[10], payload[11], payload[12]],
                ],
            })
        }
    }
}

fn decode_canvas_frame(payload: &[u8]) -> Result<Operation<'_>, DecodeError> {
    require_payload(payload, 16)?;
    let handle = read_u64(payload, 0)?;
    let width = read_u16(payload, 8)?;
    let height = read_u16(payload, 10)?;
    if width == 0 || height == 0 {
        return Err(DecodeError::new("canvas dimensions must be non-zero"));
    }
    let run_count = read_u32(payload, 12)? as usize;
    if run_count > payload.len().saturating_sub(16) / 20 {
        return Err(DecodeError::new("impossible canvas run count"));
    }
    let mut offset = 16usize;
    let mut runs = Vec::with_capacity(run_count);
    for _ in 0..run_count {
        let header_end = offset
            .checked_add(20)
            .filter(|end| *end <= payload.len())
            .ok_or_else(|| DecodeError::new("canvas run header exceeds record bounds"))?;
        let text_len = read_u32(payload, offset + 16)? as usize;
        let text_end = header_end
            .checked_add(text_len)
            .filter(|end| *end <= payload.len())
            .ok_or_else(|| DecodeError::new("canvas run text exceeds record bounds"))?;
        let text = std::str::from_utf8(&payload[header_end..text_end])
            .map_err(|_| DecodeError::new("canvas run text is not valid UTF-8"))?;
        runs.push(CanvasRun {
            row: read_u16(payload, offset)?,
            column: read_u16(payload, offset + 2)?,
            attributes: read_u16(payload, offset + 4)?,
            foreground: decode_color(read_u32(payload, offset + 8)?)?,
            background: decode_color(read_u32(payload, offset + 12)?)?,
            text,
        });
        let run = runs.last().expect("the run was just appended");
        if run.row >= height || run.column >= width {
            return Err(DecodeError::new("canvas run starts outside the frame"));
        }
        if run.text.is_empty() || run.text.contains(['\r', '\n']) {
            return Err(DecodeError::new("canvas run text is empty or multiline"));
        }
        if payload[offset + 6..offset + 8]
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(DecodeError::new("non-zero canvas run padding"));
        }
        offset = text_end;
    }
    if payload[offset..].iter().any(|byte| *byte != 0) {
        return Err(DecodeError::new("non-zero canvas frame padding"));
    }
    Ok(Operation::SetCanvasFrame {
        handle,
        width,
        height,
        runs,
    })
}

fn decode_color(packed: u32) -> Result<ColorSpec, DecodeError> {
    let kind = packed >> 24;
    let value = packed & 0x00ff_ffff;
    match (kind, value) {
        (0, 0) => Ok(ColorSpec::Default),
        (1, 0..=0xff) => Ok(ColorSpec::Indexed(value as u8)),
        (2, _) => Ok(ColorSpec::Rgb(
            ((value >> 16) & 0xff) as u8,
            ((value >> 8) & 0xff) as u8,
            (value & 0xff) as u8,
        )),
        _ => Err(DecodeError::new("invalid packed color")),
    }
}

fn decode_text_operation<'a>(
    payload: &'a [u8],
    make: impl FnOnce(u64, &'a str) -> Operation<'a>,
) -> Result<Operation<'a>, DecodeError> {
    require_payload(payload, 16)?;
    let handle = read_u64(payload, 0)?;
    let text_len = read_u32(payload, 8)? as usize;
    let text_end = 16usize
        .checked_add(text_len)
        .filter(|end| *end <= payload.len())
        .ok_or_else(|| DecodeError::new("PTX1 text exceeds record bounds"))?;
    let text = std::str::from_utf8(&payload[16..text_end])
        .map_err(|_| DecodeError::new("PTX1 text is not valid UTF-8"))?;
    if payload[text_end..].iter().any(|byte| *byte != 0) {
        return Err(DecodeError::new("non-zero PTX1 text padding"));
    }
    Ok(make(handle, text))
}

fn require_payload(payload: &[u8], minimum: usize) -> Result<(), DecodeError> {
    if payload.len() < minimum {
        Err(DecodeError::new("PTX1 operation payload is truncated"))
    } else {
        Ok(())
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, DecodeError> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| DecodeError::new("truncated PTX1 u16"))?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, DecodeError> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| DecodeError::new("truncated PTX1 u32"))?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, DecodeError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| DecodeError::new("truncated PTX1 u64"))?;
    Ok(u64::from_le_bytes([
        value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_bus_decodes_the_fixed_profile_payload() {
        let payload = [1, 3, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 255, 0, 0, 0];

        assert_eq!(
            decode_operation(Opcode::SetEffectBus, &payload).unwrap(),
            Operation::SetEffectBus {
                profile: EffectBusProfile::GhosttyPaletteV1,
                enabled: true,
                trigger: true,
                channels: [[1, 2, 3], [4, 5, 6], [7, 8, 255]],
            }
        );
    }

    #[test]
    fn effect_bus_rejects_unknown_profiles_flags_and_padding() {
        let mut payload = [0_u8; 16];
        assert_eq!(
            decode_operation(Opcode::SetEffectBus, &payload)
                .unwrap_err()
                .to_string(),
            "unsupported effect bus profile"
        );

        payload[0] = 1;
        payload[1] = 4;
        assert_eq!(
            decode_operation(Opcode::SetEffectBus, &payload)
                .unwrap_err()
                .to_string(),
            "unknown required effect bus flag"
        );

        payload[1] = 0;
        payload[15] = 1;
        assert_eq!(
            decode_operation(Opcode::SetEffectBus, &payload)
                .unwrap_err()
                .to_string(),
            "non-zero SetEffectBus padding"
        );
    }

    #[test]
    fn cursor_shape_uses_one_formerly_reserved_byte() {
        let mut payload = [0_u8; 16];
        payload[4] = 1;
        payload[5] = 1;
        assert_eq!(
            decode_operation(Opcode::SetCursor, &payload).unwrap(),
            Operation::SetCursor {
                row: 0,
                column: 0,
                visible: true,
                shape: CursorShape::Underline,
                color: ColorSpec::Default,
            }
        );

        payload[5] = 3;
        assert_eq!(
            decode_operation(Opcode::SetCursor, &payload)
                .unwrap_err()
                .to_string(),
            "invalid cursor shape 3"
        );
        payload[5] = 0;
        payload[6] = 1;
        assert_eq!(
            decode_operation(Opcode::SetCursor, &payload)
                .unwrap_err()
                .to_string(),
            "non-zero SetCursor padding"
        );
    }
}
