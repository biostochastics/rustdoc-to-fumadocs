//! Link to [`Public::new`] and the [usage notes](Public#usage).
//! See [`Vec`], [`Vec::new`], [`Option`], [`Option::Some`], and [`std::vec::Vec::new`].
#![allow(dead_code, unused_imports, non_camel_case_types)]
#![feature(trait_alias)]

/// # Usage
///
/// Construct one with [`Public::new`].
pub struct Public {
    /// Part of the API.
    pub shown: u32,
    private_field: u64,
}
impl Public {
    pub fn new() -> Self {
        Self {
            shown: 0,
            private_field: 0,
        }
    }
    pub(crate) fn crate_method() {}
    fn private_method() {}
    #[cfg(feature = "optional")]
    pub fn optional_method() {}
}

pub struct Tuple(
    u32,
    /// Public field at position one.
    pub u64,
);

pub struct Generic<T>(pub T);
impl<T> Generic<T>
where
    T: Clone + Ord,
{
    pub fn constrained(&self) {}
}

pub enum Color {
    Blue,
    #[cfg(feature = "optional")]
    Green,
}
/// A color alias.
pub use Color::Blue as Primary;

mod inner {
    pub struct Original;
}
/// Public alias documentation.
#[deprecated(since = "0.2.0", note = "Use Public")]
pub use inner::Original as Export;

pub mod functions {
    pub fn nested() {}
}
pub fn root_fn() {}

pub struct Case;
pub struct CASE;
pub trait Marker {}
pub mod left {
    pub struct Handle;
    pub struct Scoped(pub(in crate::left) u16);
}
pub mod right {
    pub struct Handle;
}
impl Marker for left::Handle {}
impl Marker for right::Handle {}

// Both public paths reach the same use in a private module.
mod common {
    pub struct Shared;
}
mod imports {
    #[doc(inline)]
    pub use super::common::Shared;
}
mod first {
    pub use super::imports::*;
}
mod second {
    pub use super::imports::*;
}
pub use first::*;
pub use second::*;

pub trait Clonable = Clone + Send;
unsafe extern "C" {
    pub static BITS: u32;
    pub safe static SAFE_BITS: u32;
}

// Regenerate from the repository root, using a rustdoc binary for the desired format.
// RUSTC_BOOTSTRAP=1 rustdoc --edition=2021 --crate-type=lib --crate-name layout_cases \
//   -Z unstable-options --output-format=json --document-private-items --cfg 'feature="optional"' \
//   --out-dir /tmp/layout-fixtures tests/fixtures/layout_cases.rs
// python3 scripts/prune-fixture.py /tmp/layout-fixtures/layout_cases.json tests/fixtures/layout_cases.v60.json
