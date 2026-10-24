//! Publish complete files before database references or task receipts become visible.
use std::{io, path::Path};

#[cfg(test)]
thread_local! {
    pub static FAILURE: std::cell::Cell<Option<(&'static str, io::ErrorKind)>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn fault(operation: &str) -> io::Result<()> {
    FAILURE.with(|failure| match failure.get() {
        Some((name, kind)) if name == operation => {
            failure.set(None);
            Err(io::Error::from(kind))
        }
        _ => Ok(()),
    })
}

pub fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(test)]
    fault("sync")?;
    std::fs::File::open(path)?.sync_all()
}

pub fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

pub fn persist(
    file: tempfile::NamedTempFile,
    destination: &Path,
    overwrite: bool,
) -> io::Result<()> {
    #[cfg(test)]
    fault("persist")?;
    file.as_file().sync_all()?;
    {
        if overwrite {
            file.persist(destination)
        } else {
            file.persist_noclobber(destination)
        }
        .map_err(|error| error.error)?;
        sync_directory(destination.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Missing parent directory")
        })?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn publication_preserves_existing_content_unless_replacement_is_requested() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("asset");
        for (content, overwrite, succeeds) in [
            ("first", false, true),
            ("rejected", false, false),
            ("replacement", true, true),
        ] {
            let mut file = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
            file.write_all(content.as_bytes()).unwrap();
            assert_eq!(persist(file, &path, overwrite).is_ok(), succeeds);
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                if succeeds { content } else { "first" }
            );
        }
    }
}
