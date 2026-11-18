//! Minimal re-export fixture: an item defined in a private module and
//! re-exported at the crate root must get a page at the re-export path.

mod m {
    /// A struct that is only reachable through `pub use m::Foo`.
    pub struct Foo;
}

pub use m::Foo;
