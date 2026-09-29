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
    #[cfg(not(target_os = "windows"))]
    return std::fs::File::open(path)?.sync_all();
    // Windows publication uses MoveFileExW with WRITE_THROUGH instead of directory fsync.
    #[cfg(target_os = "windows")]
    {
        let _ = path;
        Ok(())
    }
}

pub fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    return std::fs::rename(source, destination);
    #[cfg(target_os = "windows")]
    return move_file(source, destination, true);
}

#[cfg(target_os = "windows")]
fn move_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide = |path: &Path| -> io::Result<Vec<u16>> {
        let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"));
        }
        value.push(0);
        Ok(value)
    };
    let source = wide(source)?;
    let destination = wide(destination)?;
    let flags = MOVEFILE_WRITE_THROUGH
        | if overwrite {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    // Both buffers are NUL-terminated and live for the duration of the call.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn persist(
    file: tempfile::NamedTempFile,
    destination: &Path,
    overwrite: bool,
) -> io::Result<()> {
    #[cfg(test)]
    fault("persist")?;
    file.as_file().sync_all()?;
    #[cfg(target_os = "windows")]
    move_file(&file.into_temp_path(), destination, overwrite)?;
    #[cfg(not(target_os = "windows"))]
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
