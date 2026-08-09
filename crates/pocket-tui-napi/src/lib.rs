use napi_derive::napi;

#[napi]
pub fn native_version() -> &'static str {
    pocket_tui_core::VERSION
}
