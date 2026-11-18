//! Proc-macro fixture: a derive, an attribute macro and a bang macro.

use proc_macro::TokenStream;

/// Derives the `Kitchen` marker. Helper attribute: `#[kitchen(...)]`.
#[proc_macro_derive(Kitchen, attributes(kitchen))]
pub fn derive_kitchen(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}

/// An attribute macro that returns its input unchanged.
#[proc_macro_attribute]
pub fn sink(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}

/// A function-like macro that expands to nothing.
#[proc_macro]
pub fn tap(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}
