//! A session clock that ignores wall-clock adjustments and includes system sleep.
use crate::contract::Result;
use std::cell::Cell;

#[derive(Default)]
pub struct SessionClock {
    anchor: Cell<Option<(i64, u64)>>,
    #[cfg(test)]
    reading: Cell<Option<(i64, u64)>>,
}

impl SessionClock {
    pub fn now(&self) -> Result<i64> {
        self.at_least(0)
    }

    pub fn started(&self) -> bool {
        self.anchor.get().is_some()
    }

    pub fn at_least(&self, saved: i64) -> Result<i64> {
        #[cfg(test)]
        let reading = self.reading.get();
        #[cfg(not(test))]
        let reading: Option<(i64, u64)> = None;
        let (wall, tick) = match reading {
            Some(reading) => reading,
            None => (crate::store::now(), continuous_millis()?),
        };
        // Choose the restored database's time domain once. Reading older sessions later
        // must never move a running exam's clock forwards.
        let (base, started) = self.anchor.get().unwrap_or((wall.max(saved), tick));
        self.anchor.set(Some((base, started)));
        Ok(base.saturating_add(tick.saturating_sub(started).min(i64::MAX as u64) as i64))
    }

    #[cfg(test)]
    pub fn set(&self, wall: i64, tick: u64) {
        self.reading.set(Some((wall, tick)));
    }
}

#[cfg(target_os = "macos")]
fn continuous_millis() -> Result<u64> {
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    let mut scale = Timebase { numer: 0, denom: 0 };
    // Both functions only read the system clock; the kernel fills this two-u32 struct.
    unsafe {
        if mach_timebase_info(&mut scale) != 0 || scale.denom == 0 {
            return Err("Cannot read the continuous session clock".into());
        }
        Ok(
            (u128::from(mach_continuous_time()) * u128::from(scale.numer)
                / u128::from(scale.denom)
                / 1_000_000) as u64,
        )
    }
}

#[cfg(target_os = "android")]
fn continuous_millis() -> Result<u64> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // Bionic CLOCK_BOOTTIME is monotonic and includes Android suspended time.
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut time) } != 0 {
        return Err(std::io::Error::last_os_error().to_string().into());
    }
    Ok(time.tv_sec as u64 * 1000 + time.tv_nsec as u64 / 1_000_000)
}

#[cfg(target_os = "windows")]
fn continuous_millis() -> Result<u64> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount64() -> u64;
    }
    Ok(unsafe { GetTickCount64() })
}
