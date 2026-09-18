use std::{
    fs::{self, File},
    io::{BufReader, Cursor, Read, Seek},
    path::Path,
    sync::Arc,
};

use calamine::{Data, Range, Reader, Sheets, open_workbook_auto, open_workbook_auto_from_rs};
use napi::Result;

use crate::state::error;

/// Calamine's reader type differs for files and owned bytes. Delegate format
/// recognition and workbook semantics to upstream; only adapt input ownership.
pub(crate) enum Book {
    File(Sheets<BufReader<File>>),
    Bytes(Sheets<Cursor<Arc<[u8]>>>),
}

impl Book {
    pub(crate) fn open_file(path: impl AsRef<Path>, max_bytes: u32) -> Result<Self> {
        let metadata = fs::metadata(&path).map_err(|e| error("ERR_IO", e))?;
        if !metadata.is_file() {
            return Err(error("ERR_INPUT", "expected a regular file"));
        }
        if metadata.len() > max_bytes.into() {
            return Err(error("ERR_INPUT_LIMIT", "file exceeds maxInputBytes"));
        }

        open_workbook_auto(path)
            .map(Self::File)
            .map_err(|e| error("ERR_WORKBOOK", e))
    }

    pub(crate) fn open_bytes(bytes: Arc<[u8]>, max_bytes: u32) -> Result<Self> {
        if bytes.len() > max_bytes as usize {
            return Err(error("ERR_INPUT_LIMIT", "buffer exceeds maxInputBytes"));
        }

        // Upstream tries multiple readers using Clone. Arc makes those retries
        // share immutable bytes instead of copying the entire workbook each time.
        let source = Cursor::new(bytes);
        open_workbook_auto_from_rs(source)
            .map(Self::Bytes)
            .map_err(|e| error("ERR_WORKBOOK", e))
    }

    pub(crate) fn format(&self) -> &'static str {
        match self {
            Self::File(book) => format(book),
            Self::Bytes(book) => format(book),
        }
    }

    pub(crate) fn sheets_metadata(&self) -> &[calamine::Sheet] {
        match self {
            Self::File(book) => book.sheets_metadata(),
            Self::Bytes(book) => book.sheets_metadata(),
        }
    }

    pub(crate) fn defined_names(&self) -> &[(String, String)] {
        match self {
            Self::File(book) => book.defined_names(),
            Self::Bytes(book) => book.defined_names(),
        }
    }

    pub(crate) fn worksheet_range(
        &mut self,
        name: &str,
    ) -> std::result::Result<Range<Data>, calamine::Error> {
        match self {
            Self::File(book) => book.worksheet_range(name),
            Self::Bytes(book) => book.worksheet_range(name),
        }
    }

    pub(crate) fn worksheet_formula(
        &mut self,
        name: &str,
    ) -> std::result::Result<Range<String>, calamine::Error> {
        match self {
            Self::File(book) => book.worksheet_formula(name),
            Self::Bytes(book) => book.worksheet_formula(name),
        }
    }

    pub(crate) fn vba_project(
        &mut self,
    ) -> std::result::Result<Option<calamine::vba::VbaProject>, calamine::Error> {
        match self {
            Self::File(book) => book.vba_project(),
            Self::Bytes(book) => book.vba_project(),
        }
    }
}

fn format<RS: Read + Seek>(book: &Sheets<RS>) -> &'static str {
    match book {
        Sheets::Xls(_) => "xls",
        Sheets::Xlsx(_) => "xlsx",
        Sheets::Xlsb(_) => "xlsb",
        Sheets::Ods(_) => "ods",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_use_upstream_format_detection() -> Result<()> {
        for (bytes, expected) in [
            (&include_bytes!("../test/fixtures/cells.xlsx")[..], "xlsx"),
            (&include_bytes!("../test/fixtures/cells.xls")[..], "xls"),
        ] {
            let mut book = Book::open_bytes(Arc::from(bytes), u32::MAX)?;
            assert_eq!(book.format(), expected);
            assert_eq!(
                book.worksheet_range("Offset")
                    .map_err(|e| error("TEST", e))?
                    .start(),
                Some((2, 2))
            );
        }
        Ok(())
    }

    #[test]
    fn invalid_input_is_an_error() {
        assert!(Book::open_bytes(Arc::from(&b"not a workbook"[..]), u32::MAX).is_err());
    }
}
