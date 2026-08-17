/**
 * Remove comments from JavaScript source, for tests that assert on what the code
 * DOES rather than on what it explains.
 *
 * Line-based on purpose. The obvious implementation is a pair of regex replaces —
 * one for block comments, one for anything after a double slash — and it is wrong
 * on this codebase in a way that HIDES failures rather than causing them.
 *
 * A regex literal such as the https matcher in popup.js contains two consecutive
 * escaped slashes. The naive line-comment pattern reads them as the start of a
 * comment and deletes everything after that point in the file. A test then
 * "passes" because the code it was scanning is gone.
 *
 * That actually happened here: the no-hashed-class lint was scanning a truncated
 * content.js. So this strips only lines that are ENTIRELY comments, and tracks
 * block comments across lines, which cannot swallow code.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;

  for (const line of src.split("\n")) {
    const trimmed = line.trim();

    if (inBlock) {
      // A block comment's closing line may carry trailing code after the `*/`.
      const end = trimmed.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      inBlock = false;
      const after = trimmed.slice(end + 2).trim();
      out.push(after);
      continue;
    }

    // A line that is nothing but a comment.
    if (trimmed.startsWith("//")) {
      out.push("");
      continue;
    }

    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/", 2);
      if (end === -1) {
        inBlock = true;
        out.push("");
      } else {
        out.push(trimmed.slice(end + 2).trim());
      }
      continue;
    }

    // A continuation line inside a JSDoc block that opened on an earlier line is
    // handled by `inBlock`; a bare `*` prefix outside one is not a comment.
    out.push(line);
  }

  return out.join("\n");
}
