#!/usr/bin/env python3
# .idz files are IdentityDisk format
import argparse
import json
import re
from copy import deepcopy
from typing import Any, Dict, List, Optional

# ------------------------- JSON Pointer / $ref utils -------------------------

def resolve_pointer(doc: Dict[str, Any], pointer: str) -> Any:
    """Resolve a JSON Pointer like '#/components/schemas/Foo'."""
    if not pointer.startswith("#/"):
        return None
    cur: Any = doc
    for p in pointer[2:].split("/"):
        p = p.replace("~1", "/").replace("~0", "~")  # RFC 6901 unescape
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return None
    return cur

def deref(obj: Any, doc: Dict[str, Any], seen: Optional[set] = None) -> Any:
    """Deeply dereference objects with '$ref'. Avoid cycles with 'seen'."""
    if seen is None:
        seen = set()
    if isinstance(obj, dict) and "$ref" in obj:
        ref = obj["$ref"]
        if ref in seen:
            # Break cycles conservatively
            return {"type": "object"}
        seen.add(ref)
        target = resolve_pointer(doc, ref)
        if target is None:
            return {}
        merged = deepcopy(target)
        for k, v in obj.items():
            if k != "$ref":
                merged[k] = v
        return deref(merged, doc, seen)
    elif isinstance(obj, dict):
        return {k: deref(v, doc, seen.copy()) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [deref(v, doc, seen.copy()) for v in obj]
    return obj

# ------------------------- Schema -> compact TS-like type ----------------------

def ts_type_from_schema(s: Dict[str, Any],
                        doc: Dict[str, Any],
                        depth: int = 0,
                        max_depth: int = 4) -> str:
    """Turn (possibly $ref'd) JSON Schema into a compact TS-like type string."""
    if s is None:
        return "unknown"
    if "$ref" in s:
        s = deref(s, doc)

    if depth >= max_depth:
        t = s.get("type")
        if t == "array":
            return ts_type_from_schema(s.get("items", {}), doc, depth, max_depth) + "[]"
        return t if isinstance(t, str) else "object"

    # combinators
    if "oneOf" in s:
        return " | ".join(ts_type_from_schema(x, doc, depth+1, max_depth) for x in s["oneOf"])
    if "anyOf" in s:
        return " | ".join(ts_type_from_schema(x, doc, depth+1, max_depth) for x in s["anyOf"])
    if "allOf" in s:
        return " & ".join(ts_type_from_schema(x, doc, depth+1, max_depth) for x in s["allOf"])

    # exact/enum
    if "const" in s:
        return json.dumps(s["const"])
    if "enum" in s:
        return " | ".join(json.dumps(v) for v in s["enum"])

    t = s.get("type")
    fmt = s.get("format")

    # arrays
    if t == "array":
        return f"{ts_type_from_schema(s.get('items', {}), doc, depth+1, max_depth)}[]"

    # objects
    if t == "object" or ("properties" in s) or ("additionalProperties" in s):
        props = s.get("properties", {}) or {}
        required = set(s.get("required", []) or [])
        lines: List[str] = []
        for name, subschema in props.items():
            if name.startswith("x-"):
                continue
            dtype = ts_type_from_schema(subschema, doc, depth+1, max_depth)
            desc = (subschema.get("description") or subschema.get("title") or "").strip()
            enum_vals = subschema.get("enum")
            if enum_vals and not desc:
                desc = f"one of {', '.join(map(str, enum_vals))}"
            opt = "" if name in required else "?"
            default = subschema.get("default", None)
            default_note = f" (default: {json.dumps(default)})" if default not in (None, {}, []) else ""
            fmt_note = f" ({subschema.get('format')})" if subschema.get("format") else ""
            meta_bits = [x for x in [desc.replace("\n", " ").strip(), fmt_note.strip(), default_note.strip()] if x]
            comment = f" // {' '.join(meta_bits)}" if meta_bits else ""
            lines.append(f"  {name}{opt}: {dtype};{comment}")

        addl = s.get("additionalProperties", False)
        if isinstance(addl, dict):
            addl_type = ts_type_from_schema(addl, doc, depth+1, max_depth)
            lines.append(f"  [key: string]: {addl_type};")

        inner = "\n".join(lines)
        return "{\n" + inner + ("\n" if inner else "") + "}"

    # primitives
    if t in ("string", "number", "integer", "boolean", "null"):
        base = "number" if t == "integer" else t
        return f"{base} /* {fmt} */" if fmt else base

    # inference / fallback
    if t is None:
        if not s:
            return "any"
        if any(k in s for k in ("pattern", "minLength", "maxLength")):
            return "string"
        if "properties" in s:
            return ts_type_from_schema({"type": "object", **s}, doc, depth, max_depth)
        if "items" in s:
            return ts_type_from_schema({"type": "array", **s}, doc, depth, max_depth)
        return "any"

    return "any"

def clean_text(text: Optional[str]) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()

# ------------------------- Extraction helpers --------------------------------

HTTP_METHODS = {"get","put","post","delete","patch","options","head","trace"}

def deref_parameter(p: Dict[str, Any], spec: Dict[str, Any]) -> Dict[str, Any]:
    return deref(p, spec) if "$ref" in p else p

def summarize_parameter(p: Dict[str, Any], spec: Dict[str, Any]) -> str:
    """One string per parameter: '<in>:<name> — <type> (required|optional) — <desc>'"""
    p = deref_parameter(p, spec)
    schema = p.get("schema", {})
    if "$ref" in schema:
        schema = deref(schema, spec)
    dtype = ts_type_from_schema(schema, spec, max_depth=2)
    name = p.get("name", "")
    where = p.get("in", "")
    req = "required" if p.get("required", False) else "optional"
    desc = clean_text(p.get("description") or "")
    s = f"{where}:{name} — {dtype} ({req})"
    if desc:
        s += f" — {desc}"
    return s

def extract_request_body_str(op: Dict[str, Any], spec: Dict[str, Any], max_depth: int) -> str:
    rb = op.get("requestBody")
    if not rb:
        return ""
    rb = deref(rb, spec)
    content = rb.get("content") or {}
    preferred = ["application/json", "application/*+json", "multipart/form-data", "application/x-www-form-urlencoded"]
    ct = next((k for k in preferred if k in content), None)
    if ct is None and content:
        ct = next(iter(content.keys()))
    if not ct:
        return ""
    schema = (content.get(ct) or {}).get("schema")
    if not schema:
        return ""
    return ts_type_from_schema(schema, spec, max_depth=max_depth)

# ------------------------- Main builder --------------------------------------

def build_entries(spec: Dict[str, Any], max_depth: int = 4) -> Dict[str, Any]:
    entries: List[Dict[str, Any]] = []
    paths = spec.get("paths", {}) or {}

    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue

        path_params = [deref_parameter(p, spec) for p in path_item.get("parameters", [])] if "parameters" in path_item else []

        for method in HTTP_METHODS:
            if method not in path_item:
                continue
            op = path_item[method]

            # Keep BOTH summary and description; also consider operationId as a last-resort summary.
            summary_raw = clean_text(op.get("summary") or "")
            description_raw = clean_text(op.get("description") or "")
            op_id = clean_text(op.get("operationId") or "")
            if not summary_raw and not description_raw and op_id:
                summary_raw = op_id  # fallback context

            # content prefers summary, else description
            content_text = summary_raw if summary_raw else description_raw

            # parameters: merge path + op, dedupe by (name, in)
            op_params = [deref_parameter(p, spec) for p in op.get("parameters", [])] if "parameters" in op else []
            merged: Dict[tuple, Dict[str, Any]] = {}
            for p in path_params + op_params:
                key = (p.get("name"), p.get("in"))
                merged[key] = p
            param_strings = []
            for p in merged.values():
                if p.get("name"):
                    param_strings.append(summarize_parameter(p, spec))
            param_strings.sort()

            # request body (TS-like compact)
            rb_str = extract_request_body_str(op, spec, max_depth=max_depth)

            metadata: Dict[str, Any] = {
                "endpoint": path,
                "method": method.upper(),
            }
            if summary_raw:
                metadata["summary"] = summary_raw
            if description_raw:
                metadata["description"] = description_raw
            if param_strings:
                metadata["parameters"] = param_strings
            if rb_str:
                metadata["requestBody"] = rb_str

            entries.append({
                "content": content_text,
                "metadata": metadata
            })

    return {"entries": entries}

# ------------------------- CLI ------------------------------------------------
# wget https://developers.cloudflare.com/api/openapi.json
# python generator.py -i openapi.json -o cf-api.idz

def main():
    ap = argparse.ArgumentParser(description="Flatten OpenAPI to entries JSON (strings in metadata; parameters as list).")
    ap.add_argument("-i", "--input", default="openapi.json", help="Path to OpenAPI JSON (default: openapi.json)")
    ap.add_argument("-o", "--output", default="cloudflare_api_entries.json", help="Output JSON path")
    ap.add_argument("--max-depth", type=int, default=4, help="Max nesting depth for requestBody type simplification (default: 4)")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        spec = json.load(f)

    out = build_entries(spec, max_depth=args.max_depth)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"Wrote {len(out['entries'])} entries to {args.output}")

if __name__ == "__main__":
    main()

