//! Asynchronous spreadsheet reading through Node-API.
//!
//! Rust owns input snapshots, task admission, parsing, and native resources.
//! The TypeScript facade adapts inputs and delivers bounded JavaScript batches.

mod cancellation;
mod cell;
mod executor;
mod reader;
mod sheet;
mod source;
mod state;
mod stream;
mod vba;
mod workbook;
