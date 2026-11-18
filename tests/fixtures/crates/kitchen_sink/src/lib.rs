//! Kitchen-sink fixture for rustdoc-to-fumadocs.
//!
//! Start with [`Widget`] or the [`shapes`] module. The crate-level
//! re-export [`Circle`] points at [`shapes::Circle`], and
//! [the inline square](crate::InlineSquare) is inlined. See also
//! [`Vec`] and [`Widget::new`].

#![cfg_attr(docsrs, feature(doc_cfg))]
#![allow(dead_code)]

use std::collections::HashMap;

mod m {
    /// A struct only reachable through `pub use m::Foo`.
    pub struct Foo;

    /// Renamed on re-export to [`RenamedThing`](crate::RenamedThing).
    pub struct Original;
}

mod globbed {
    /// Re-exported through a glob.
    pub fn glob_fn() {}

    /// Also re-exported through a glob.
    pub struct GlobStruct;
}

mod private {
    pub mod hidden_tree {
        //! A private module re-exported as a public name.

        /// Lives in a re-exported private module.
        pub struct Leaf;

        /// A function inside the re-exported private module.
        pub fn leaf_fn() -> Leaf {
            Leaf
        }
    }
}

/// Shapes live here.
pub mod shapes {
    /// A circle. Compare with [`Square`].
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Circle {
        /// Radius in millimetres.
        pub radius: u32,
    }

    /// A square.
    pub struct Square;
}

pub use globbed::*;
pub use private::hidden_tree as tree;
pub use m::Foo;
pub use m::Original as RenamedThing;
pub use shapes::Circle;
#[doc(inline)]
pub use shapes::Square as InlineSquare;
pub use std::collections::BTreeMap;

/// A widget with awkward field types.
///
/// Use [`Widget::new`] to build one, then call [`Self::label`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Widget {
    pub name: Option<String>,
    pub keys: Vec<[u8; 32]>,
    /// A map from names to bytes, `HashMap<String, Vec<u8>>`.
    pub table: HashMap<String, Vec<u8>>,
    secret: u8,
}

impl Widget {
    /// Builds a widget from anything string-like.
    ///
    /// # Panics
    ///
    /// Panics if `name` is empty.
    ///
    /// # Examples
    ///
    /// ```
    /// # use kitchen_sink::Widget;
    /// # fn main() {
    /// let w = Widget::new("hello");
    /// assert_eq!(w.label(), "hello");
    /// # }
    /// ```
    #[must_use]
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        assert!(!name.is_empty());
        Widget { name: Some(name), ..Default::default() }
    }

    /// Returns the label.
    ///
    /// ```rust,ignore
    /// let x = 1;
    /// ```
    pub fn label(&self) -> &str {
        self.name.as_deref().unwrap_or("")
    }

    /// Tries to parse a widget.
    ///
    /// # Errors
    ///
    /// Returns [`ParseFailure`] when `s` is empty.
    pub fn parse(s: &str) -> Result<Self, ParseFailure> {
        if s.is_empty() {
            Err(ParseFailure)
        } else {
            Ok(Widget::new(s))
        }
    }

    /// Deprecated helper.
    #[deprecated(since = "0.2.0", note = "use \"label\" with `Vec<T>` instead")]
    pub fn old_label(&self) -> &str {
        self.label()
    }
}

#[cfg(feature = "extra")]
#[cfg_attr(docsrs, doc(cfg(feature = "extra")))]
impl Widget {
    /// Only with the `extra` feature.
    pub fn extra_method(&self) {}
}

/// Parse error for [`Widget::parse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseFailure;

impl core::fmt::Display for ParseFailure {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("parse failure")
    }
}

impl std::error::Error for ParseFailure {}

/// A raw union.
#[repr(C)]
pub union RawBits {
    pub word: u64,
    pub bytes: [u8; 8],
    pub pair: core::mem::ManuallyDrop<Option<[u16; 2]>>,
}

/// A shape trait with supertraits, associated items and provided methods.
pub trait Shape: core::fmt::Debug + Clone {
    /// The output of [`Shape::area`].
    type Output: Copy;

    /// Number of sides.
    const SIDES: u32;

    /// Default scale.
    const SCALE: u32 = 1;

    /// Computes the area.
    fn area(&self) -> Self::Output;

    /// Describes the shape (provided).
    fn describe(&self) -> String {
        format!("{:?}", self)
    }
}

impl Shape for shapes::Circle {
    type Output = u64;
    const SIDES: u32 = 0;

    fn area(&self) -> u64 {
        3 * u64::from(self.radius) * u64::from(self.radius)
    }
}

/// Converts things; takes a closure.
///
/// Background: [the spec](../docs/spec.md) and the
/// [usage notes](../README.md#usage).
pub fn apply<F>(f: F, value: impl AsRef<str>) -> usize
where
    F: Fn(&str) -> usize,
{
    f(value.as_ref())
}

/// Only with the `extra` feature.
#[cfg(feature = "extra")]
#[cfg_attr(docsrs, doc(cfg(feature = "extra")))]
pub mod extra {
    /// Inherits the module's feature gate.
    pub struct ExtraThing;

    /// Needs `extra` and `fancy`.
    #[cfg(feature = "fancy")]
    #[cfg_attr(docsrs, doc(cfg(feature = "fancy")))]
    pub fn fancy_extra() {}
}

/// Available with either feature.
#[cfg(any(feature = "extra", feature = "fancy"))]
#[cfg_attr(docsrs, doc(cfg(any(feature = "extra", feature = "fancy"))))]
pub fn either_feature() {}

/// Available only without `nope`.
#[cfg(not(feature = "nope"))]
#[cfg_attr(docsrs, doc(cfg(not(feature = "nope"))))]
pub fn plain_only() {}

/// A gated struct (cfg only, no doc(cfg)).
#[cfg(feature = "fancy")]
pub struct FancyOnly;

/// A unit-style constant.
pub const ANSWER: u32 = 42;

/// A macro that uses `$crate`.
#[macro_export]
macro_rules! widget {
    ($name:expr) => {
        $crate::Widget::new($name)
    };
}
