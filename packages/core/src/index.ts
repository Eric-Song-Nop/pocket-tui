/** PocketTUI package version. */
export const version = "0.1.0";

export {
  BoxHandle,
  SceneHandle,
  TextHandle,
  TuiApp,
  createTui,
  type CreateTuiOptions,
  type FlushMode,
  type TuiAppState,
} from "./app.js";
export {
  PTX_HEADER_BYTES,
  PTX_MAGIC,
  PTX_MAJOR_VERSION,
  PTX_MAX_PACKET_BYTES,
  PTX_OPERATION_HEADER_BYTES,
  PtxDecodeError,
  PtxOpcode,
  PtxPacketEncoder,
  decodePtx,
  type BoxDirection,
  type BoxPacketOptions,
  type DecodedPtxOperation,
  type DecodedPtxPacket,
} from "./protocol.js";
export { loadNativeBinding, type NativeBinding, type NativeTuiSession } from "./native.js";
