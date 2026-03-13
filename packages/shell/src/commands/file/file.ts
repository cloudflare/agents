/**
 * file - determine file type
 *
 * Uses the file-type npm package for magic byte detection.
 */

import { fileTypeFromBuffer } from "file-type";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const fileHelp = {
  name: "file",
  summary: "determine file type",
  usage: "file [OPTION]... FILE...",
  options: [
    "-b, --brief          do not prepend filenames to output",
    "-i, --mime           output MIME type strings",
    "-L, --dereference    follow symlinks",
    "    --help           display this help and exit"
  ]
};

interface FileType {
  description: string;
  mime: string;
}

// Extension-based type detection for text files (Map prevents prototype pollution)
const EXTENSION_TYPES = new Map<string, FileType>([
  // Programming languages
  [".js", { description: "JavaScript source", mime: "text/javascript" }],
  [".mjs", { description: "JavaScript module", mime: "text/javascript" }],
  [".cjs", { description: "CommonJS module", mime: "text/javascript" }],
  [".ts", { description: "TypeScript source", mime: "text/typescript" }],
  [".tsx", { description: "TypeScript JSX source", mime: "text/typescript" }],
  [".jsx", { description: "JavaScript JSX source", mime: "text/javascript" }],
  [".py", { description: "Python script", mime: "text/x-python" }],
  [".rb", { description: "Ruby script", mime: "text/x-ruby" }],
  [".go", { description: "Go source", mime: "text/x-go" }],
  [".rs", { description: "Rust source", mime: "text/x-rust" }],
  [".c", { description: "C source", mime: "text/x-c" }],
  [".h", { description: "C header", mime: "text/x-c" }],
  [".cpp", { description: "C++ source", mime: "text/x-c++" }],
  [".hpp", { description: "C++ header", mime: "text/x-c++" }],
  [".java", { description: "Java source", mime: "text/x-java" }],
  [
    ".sh",
    { description: "Bourne-Again shell script", mime: "text/x-shellscript" }
  ],
  [
    ".bash",
    { description: "Bourne-Again shell script", mime: "text/x-shellscript" }
  ],
  [".zsh", { description: "Zsh shell script", mime: "text/x-shellscript" }],
  // Data formats
  [".json", { description: "JSON data", mime: "application/json" }],
  [".yaml", { description: "YAML data", mime: "text/yaml" }],
  [".yml", { description: "YAML data", mime: "text/yaml" }],
  [".xml", { description: "XML document", mime: "application/xml" }],
  [".csv", { description: "CSV text", mime: "text/csv" }],
  [".toml", { description: "TOML data", mime: "text/toml" }],
  // Web
  [".html", { description: "HTML document", mime: "text/html" }],
  [".htm", { description: "HTML document", mime: "text/html" }],
  [".css", { description: "CSS stylesheet", mime: "text/css" }],
  [".svg", { description: "SVG image", mime: "image/svg+xml" }],
  // Documentation
  [".md", { description: "Markdown document", mime: "text/markdown" }],
  [".markdown", { description: "Markdown document", mime: "text/markdown" }],
  [".txt", { description: "ASCII text", mime: "text/plain" }],
  [".rst", { description: "reStructuredText", mime: "text/x-rst" }],
  // Config
  [".env", { description: "ASCII text", mime: "text/plain" }],
  [".gitignore", { description: "ASCII text", mime: "text/plain" }],
  [".dockerignore", { description: "ASCII text", mime: "text/plain" }]
]);

// Map file-type ext to description (Map prevents prototype pollution)
const EXT_TO_DESCRIPTION = new Map<string, string>([
  // Images
  ["jpg", "JPEG image data"],
  ["jpeg", "JPEG image data"],
  ["png", "PNG image data"],
  ["gif", "GIF image data"],
  ["webp", "WebP image data"],
  ["bmp", "PC bitmap"],
  ["ico", "MS Windows icon resource"],
  ["tif", "TIFF image data"],
  ["tiff", "TIFF image data"],
  ["psd", "Adobe Photoshop Document"],
  ["avif", "AVIF image"],
  ["heic", "HEIC image"],
  ["heif", "HEIF image"],
  ["jxl", "JPEG XL image"],
  ["icns", "Mac OS X icon"],
  ["svg", "SVG Scalable Vector Graphics image"],
  // Documents
  ["pdf", "PDF document"],
  ["epub", "EPUB document"],
  ["mobi", "Mobipocket E-book"],
  ["djvu", "DjVu document"],
  // Archives
  ["zip", "Zip archive data"],
  ["gz", "gzip compressed data"],
  ["gzip", "gzip compressed data"],
  ["bz2", "bzip2 compressed data"],
  ["xz", "XZ compressed data"],
  ["tar", "POSIX tar archive"],
  ["rar", "RAR archive data"],
  ["7z", "7-zip archive data"],
  ["lz", "lzip compressed data"],
  ["lzma", "LZMA compressed data"],
  ["zst", "Zstandard compressed data"],
  ["cab", "Microsoft Cabinet archive"],
  ["ar", "Unix ar archive"],
  ["rpm", "RPM package"],
  ["deb", "Debian binary package"],
  ["apk", "Android Package"],
  ["dmg", "Apple disk image"],
  ["iso", "ISO 9660 CD-ROM filesystem data"],
  ["vhd", "Microsoft Virtual Hard Disk"],
  ["vhdx", "Microsoft Virtual Hard Disk (new format)"],
  ["qcow2", "QEMU QCOW Image"],
  // Audio
  ["mp3", "Audio file with ID3"],
  ["m4a", "MPEG-4 audio"],
  ["aac", "AAC audio"],
  ["wav", "RIFF (little-endian) data, WAVE audio"],
  ["flac", "FLAC audio bitstream data"],
  ["ogg", "Ogg data"],
  ["oga", "Ogg audio"],
  ["opus", "Ogg Opus audio"],
  ["aiff", "AIFF audio"],
  ["wma", "Windows Media Audio"],
  ["amr", "AMR audio"],
  ["mid", "MIDI audio"],
  ["midi", "MIDI audio"],
  ["ape", "Monkey's Audio"],
  // Video
  ["mp4", "ISO Media, MPEG-4"],
  ["m4v", "MPEG-4 video"],
  ["webm", "WebM"],
  ["avi", "RIFF (little-endian) data, AVI"],
  ["mov", "ISO Media, Apple QuickTime movie"],
  ["mkv", "Matroska data"],
  ["wmv", "Windows Media Video"],
  ["flv", "Flash Video"],
  ["3gp", "3GPP multimedia"],
  ["3g2", "3GPP2 multimedia"],
  ["ogv", "Ogg video"],
  ["mts", "MPEG transport stream"],
  ["m2ts", "MPEG transport stream"],
  ["ts", "MPEG transport stream"],
  ["mpg", "MPEG video"],
  ["mpeg", "MPEG video"],
  // Executables
  ["exe", "PE32 executable"],
  ["dll", "PE32 DLL"],
  ["elf", "ELF executable"],
  ["mach", "Mach-O executable"],
  ["wasm", "WebAssembly (wasm) binary module"],
  ["dex", "Android Dalvik executable"],
  ["class", "Java class file"],
  ["swf", "Adobe Flash"],
  // Office Documents
  ["doc", "Microsoft Word Document"],
  ["docx", "Microsoft Word 2007+ Document"],
  ["xls", "Microsoft Excel Spreadsheet"],
  ["xlsx", "Microsoft Excel 2007+ Spreadsheet"],
  ["ppt", "Microsoft PowerPoint Presentation"],
  ["pptx", "Microsoft PowerPoint 2007+ Presentation"],
  ["odt", "OpenDocument Text"],
  ["ods", "OpenDocument Spreadsheet"],
  ["odp", "OpenDocument Presentation"],
  // Fonts
  ["ttf", "TrueType Font"],
  ["otf", "OpenType Font"],
  ["woff", "Web Open Font Format"],
  ["woff2", "Web Open Font Format 2"],
  ["eot", "Embedded OpenType font"],
  // 3D/CAD
  ["stl", "Stereolithography CAD"],
  ["obj", "Wavefront 3D Object"],
  ["gltf", "GL Transmission Format"],
  ["glb", "GL Transmission Format (binary)"],
  // Database
  ["sqlite", "SQLite 3.x database"],
  ["mdb", "Microsoft Access Database"],
  // Other
  ["xml", "XML document"],
  ["json", "JSON data"],
  ["macho", "Mach-O binary"],
  ["ics", "iCalendar data"],
  ["vcf", "vCard data"],
  ["msi", "Microsoft Installer"],
  ["ps", "PostScript"],
  ["ai", "Adobe Illustrator"],
  ["indd", "Adobe InDesign"],
  ["sketch", "Sketch design file"],
  ["fig", "Figma design file"],
  ["xd", "Adobe XD"],
  ["blend", "Blender"],
  ["fbx", "Autodesk FBX"],
  ["lnk", "MS Windows shortcut"],
  ["alias", "Mac OS alias"],
  ["torrent", "BitTorrent file"],
  ["pcap", "pcap capture file"],
  ["arrow", "Apache Arrow"],
  ["parquet", "Apache Parquet"]
]);

/**
 * Generate a human-readable description from extension and mime type
 */
function generateDescription(ext: string, mime: string): string {
  // Check our mapping first
  const desc = EXT_TO_DESCRIPTION.get(ext);
  if (desc) {
    return desc;
  }

  // Generate from mime type
  const [category, subtype] = mime.split("/");
  const subtypeName = subtype?.split("+")[0]?.replace(/-/g, " ") || ext;

  switch (category) {
    case "image":
      return `${subtypeName.toUpperCase()} image data`;
    case "audio":
      return `${subtypeName.toUpperCase()} audio`;
    case "video":
      return `${subtypeName.toUpperCase()} video`;
    case "font":
      return `${subtypeName} font`;
    case "model":
      return `${subtypeName} 3D model`;
    case "application":
      if (subtype?.includes("zip") || subtype?.includes("compressed")) {
        return `${subtypeName} archive data`;
      }
      if (subtype?.includes("executable")) {
        return `${subtypeName} executable`;
      }
      return `${ext.toUpperCase()} data`;
    default:
      return `${ext.toUpperCase()} data`;
  }
}

function getExtension(filename: string): string {
  const basename = filename.split("/").pop() || filename;
  if (basename.startsWith(".") && !basename.includes(".", 1)) {
    return basename;
  }
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0) return "";
  return basename.slice(dotIndex).toLowerCase();
}

function detectTextType(content: string, filename: string): FileType {
  // Check for shebang
  if (content.startsWith("#!")) {
    const firstLine = content.split("\n")[0];
    if (firstLine.includes("python")) {
      return {
        description: "Python script, ASCII text executable",
        mime: "text/x-python"
      };
    }
    if (
      firstLine.includes("node") ||
      firstLine.includes("bun") ||
      firstLine.includes("deno")
    ) {
      return {
        description: "JavaScript script, ASCII text executable",
        mime: "text/javascript"
      };
    }
    if (firstLine.includes("bash")) {
      return {
        description: "Bourne-Again shell script, ASCII text executable",
        mime: "text/x-shellscript"
      };
    }
    if (firstLine.includes("sh")) {
      return {
        description: "POSIX shell script, ASCII text executable",
        mime: "text/x-shellscript"
      };
    }
    if (firstLine.includes("ruby")) {
      return {
        description: "Ruby script, ASCII text executable",
        mime: "text/x-ruby"
      };
    }
    if (firstLine.includes("perl")) {
      return {
        description: "Perl script, ASCII text executable",
        mime: "text/x-perl"
      };
    }
    return { description: "script, ASCII text executable", mime: "text/plain" };
  }

  // Check for XML/HTML
  const trimmed = content.trimStart();
  if (trimmed.startsWith("<?xml")) {
    return { description: "XML document", mime: "application/xml" };
  }
  if (
    trimmed.startsWith("<!DOCTYPE html") ||
    trimmed.toLowerCase().startsWith("<html")
  ) {
    return { description: "HTML document", mime: "text/html" };
  }

  // Check for line endings
  const hasCRLF = content.includes("\r\n");
  const hasCR = content.includes("\r") && !hasCRLF;

  let lineEnding = "";
  if (hasCRLF) lineEnding = ", with CRLF line terminators";
  else if (hasCR) lineEnding = ", with CR line terminators";

  // Check extension
  const ext = getExtension(filename);
  const extType = ext ? EXTENSION_TYPES.get(ext) : undefined;
  if (extType) {
    // Append line ending info for text types
    if (extType.mime.startsWith("text/") && lineEnding) {
      return {
        description: `${extType.description}${lineEnding}`,
        mime: extType.mime
      };
    }
    return extType;
  }

  // Check for unicode
  let hasUnicode = false;
  for (let i = 0; i < Math.min(content.length, 8192); i++) {
    if (content.charCodeAt(i) > 127) {
      hasUnicode = true;
      break;
    }
  }

  if (hasUnicode) {
    return {
      description: `UTF-8 Unicode text${lineEnding}`,
      mime: "text/plain; charset=utf-8"
    };
  }

  return { description: `ASCII text${lineEnding}`, mime: "text/plain" };
}

async function detectFileType(
  filename: string,
  buffer: Uint8Array
): Promise<FileType> {
  // Empty file
  if (buffer.length === 0) {
    return { description: "empty", mime: "inode/x-empty" };
  }

  // Use file-type for binary detection (needs raw bytes)
  // Wrap in try-catch because file-type may throw on truncated data
  // (e.g. EndOfStreamError for a valid ZIP header with too few bytes)
  try {
    const result = await fileTypeFromBuffer(buffer);

    if (result) {
      const description = generateDescription(result.ext, result.mime);
      return { description, mime: result.mime };
    }
  } catch {
    // file-type threw (truncated data) — fall through to text detection
  }

  // Fall back to text detection (convert buffer to string)
  const content = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  return detectTextType(content, filename);
}

export const fileCommand: Command = {
  name: "file",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(fileHelp);

    let brief = false;
    let mimeMode = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg.startsWith("--")) {
        if (arg === "--brief") brief = true;
        else if (arg === "--mime" || arg === "--mime-type") mimeMode = true;
        else if (arg === "--dereference") {
          /* no-op */
        } else return unknownOption("file", arg);
      } else if (arg.startsWith("-") && arg !== "-") {
        // Handle combined short flags like -bi
        for (const c of arg.slice(1)) {
          if (c === "b") brief = true;
          else if (c === "i") mimeMode = true;
          else if (c === "L") {
            /* no-op */
          } else return unknownOption("file", `-${c}`);
        }
      } else {
        files.push(arg);
      }
    }

    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "Usage: file [-bLi] FILE...\n",
        exitCode: 1
      };
    }

    let output = "";
    let exitCode = 0;

    for (const file of files) {
      try {
        const path = ctx.fs.resolvePath(ctx.cwd, file);
        const stats = await ctx.fs.stat(path);

        if (stats.isDirectory) {
          const result = mimeMode ? "inode/directory" : "directory";
          output += brief ? `${result}\n` : `${file}: ${result}\n`;
          continue;
        }

        const buffer = await ctx.fs.readFileBuffer(path);
        const fileType = await detectFileType(file, buffer);
        const result = mimeMode ? fileType.mime : fileType.description;
        output += brief ? `${result}\n` : `${file}: ${result}\n`;
      } catch {
        output += brief
          ? "cannot open\n"
          : `${file}: cannot open (No such file or directory)\n`;
        exitCode = 1;
      }
    }

    return { stdout: output, stderr: "", exitCode };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "file",
  flags: [
    { flag: "-b", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-L", type: "boolean" }
  ],
  needsArgs: true
};
