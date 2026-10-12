// Unit tests for the listing parsers (run on the host target with `cargo test`).

use ftp_engine::ftp::listing::*;

// fixed "now" for deterministic year inference (2026-06-15T12:00:00Z)
const NOW: i64 = 1_781_523_200 * 1000;

#[test]
fn parse_unix_basic() {
    let l = "drwxr-xr-x   2 root staff     4096 Sep 12 10:00 public";
    let e = parse_unix_line(l, NOW).unwrap();
    assert_eq!(e.name, "public");
    assert!(e.dir);
    assert!(e.size.is_none());
    assert_eq!(e.mode.as_deref(), Some("drwxr-xr-x"));
    assert_eq!(e.raw, l);
}

#[test]
fn parse_unix_file_with_year() {
    let l = "-rw-r--r--   1 root staff  1048576 Mar  1  2023 big.bin";
    let e = parse_unix_line(l, NOW).unwrap();
    assert_eq!(e.name, "big.bin");
    assert!(!e.dir);
    assert_eq!(e.size, Some(1_048_576));
    assert!(e.mtime.is_some());
}

#[test]
fn parse_unix_symlink() {
    let l = "lrwxrwxrwx   1 root root       7 Sep 12 10:00 link -> target";
    let e = parse_unix_line(l, NOW).unwrap();
    assert_eq!(e.name, "link");
    assert_eq!(e.link.as_deref(), Some("target"));
    assert!(!e.dir);
    assert!(e.size.is_none());
}

#[test]
fn parse_unix_skip_total() {
    let out = parse_listing("total 3\ndrwxr-xr-x   2 root staff     4096 Sep 12 10:00 d\n", ListKind::Unix, NOW);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].name, "d");
}

#[test]
fn unix_time_year_inference_recent() {
    // "Sep 12 10:00" with a fixed now; check a plausible parse (no panic)
    let ms = parse_unix_time("Sep", "12", "10:00", NOW);
    assert!(ms.is_some());
}

#[test]
fn unix_time_with_explicit_year() {
    let ms = parse_unix_time("Mar", "1", "2023", NOW).unwrap();
    // 2023-03-01 00:00:00 UTC = 1677628800
    assert_eq!(ms, 1_677_628_800_000);
}

#[test]
fn dos_dir() {
    let l = "09-12-26  10:00AM       <DIR>          docs";
    let e = parse_dos_line(l).unwrap();
    assert_eq!(e.name, "docs");
    assert!(e.dir);
}

#[test]
fn parse_dos_file() {
    let l = "09-12-26  10:00AM          1048576   report.pdf";
    let e = parse_dos_line(l).unwrap();
    assert_eq!(e.name, "report.pdf");
    assert!(!e.dir);
    assert_eq!(e.size, Some(1_048_576));
    assert!(e.mtime.is_some());
}

#[test]
fn mlsx_file() {
    let l = "type=file;size=1024;modify=20230912101234;UNIX.mode=0644; report.pdf";
    let e = parse_mlsx_line(l).unwrap();
    assert_eq!(e.name, "report.pdf");
    assert_eq!(e.size, Some(1024));
    assert!(!e.dir);
    assert!(e.mtime.is_some());
    // 2023-09-12 10:12:34 UTC = 1694513554
    assert_eq!(e.mtime, Some(1_694_513_554_000));
}

#[test]
fn parse_mlsx_dir() {
    let l = "type=dir;size=0;modify=20230912000000; pub";
    let e = parse_mlsx_line(l).unwrap();
    assert_eq!(e.name, "pub");
    assert!(e.dir);
}

#[test]
fn name_with_spaces_mlsd() {
    let l = "type=file;size=3;modify=20260101000000; my file name.txt";
    let e = parse_mlsx_line(l).unwrap();
    assert_eq!(e.name, "my file name.txt");
}

#[test]
fn auto_detection_mixed() {
    let body = "-rw-r--r--   1 root root  5 Sep 12 10:00 a.txt\r\n\
                type=file;size=5;modify=20230912100000; b.txt\r\n";
    // whole-body sniff via lines: first is unix, second is mlsd — parse both
    let a = parse_listing("-rw-r--r--   1 root root  5 Sep 12 10:00 a.txt", ListKind::Auto, NOW);
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].name, "a.txt");
    let b = parse_listing("type=file;size=5;modify=20230912100000; b.txt", ListKind::Auto, NOW);
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].name, "b.txt");
}

#[test]
fn names_kind() {
    let out = parse_listing("a\nb\nc\r\n", ListKind::Names, NOW);
    assert_eq!(out.len(), 3);
    assert_eq!(out[2].name, "c");
}

#[test]
fn civil_roundtrip() {
    // days<->civil consistency for a known point: 2023-09-12
    let ms = ymd(2023, 9, 12).unwrap();
    assert_eq!(ms, 1_694_476_800_000); // 2023-09-12T00:00:00Z
}

fn ymd(y: i32, m: u32, d: u32) -> Option<i64> {
    // re-exported via parse_mlsx_time on "YYYYMMDD000000"
    let stamp = format!("{:04}{:02}{:02}000000", y, m, d);
    mlsx_time(&stamp)
}

#[test]
fn mdtm_reply() {
    let reply = ftp_engine::ftp::control::Reply {
        code: 213,
        lines: vec!["213 20230912101234".to_string()],
    };
    let ms = parse_mdtm_reply(&reply).unwrap();
    assert_eq!(ms, 1_694_513_554_000);
}
