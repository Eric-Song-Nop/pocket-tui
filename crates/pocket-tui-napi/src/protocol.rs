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
            _ => Err(DecodeError::new(format!("unknown required opcode {value}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Column,
    Row,
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
