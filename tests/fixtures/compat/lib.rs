//! See [`Carrier`] and its [`Carrier::value`] method.
//! A literal {unit}, <br> and a <docs@example.org> address.

/// A public tuple field.
pub struct Carrier<T>(pub T);

impl<T: Clone> Carrier<T> {
    /// Copies the stored value.
    pub fn value(&self) -> T {
        self.0.clone()
    }
}

/// Calls foreign code.
pub type Callback = unsafe extern "C" fn(i32) -> i32;

pub mod nested {
    /// A publicly reachable enumeration.
    pub enum Status {
        Ready,
        Pending(u32),
    }
}
pub use nested::Status as PublicStatus;

/// Executes a predicate.
pub fn check(test: &dyn Fn(u32) -> bool) -> bool {
    test(1)
}

/// A trait with generic associated types and a constant.
pub trait Inspect {
    type Items<'a>: Iterator<Item = &'a str>
    where
        Self: 'a;
    const VERSION: usize = 1;
    fn items(&self) -> Self::Items<'_>;
}

pub const LIMIT: usize = 8;
pub static TOTAL: u8 = 0;
pub union Word {
    pub small: u8,
    pub large: u32,
}

pub fn shorten<'a, 'b>(x: &'a u8) -> &'b u8
where
    'a: 'b,
{
    x
}
