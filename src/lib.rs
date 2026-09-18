//! Async spreadsheet reading through Node-API.
//!
//! Calamine is synchronous. AsyncTask keeps its parsing and file I/O off the JS
//! thread; the TypeScript facade bounds concurrency and JavaScript result batches.

mod cell;
mod sheet;
mod source;
mod state;
mod vba;
mod workbook;

pub use workbook::{open_bytes, open_path};
