/**
 * Scrub an observed API response into something committable.
 *
 * ── THE TWO REQUIREMENTS PULL AGAINST EACH OTHER ────────────────────────────
 *
 * A fixture has to keep enough SHAPE to derive a field mapping from — every key,
 * every `$type` discriminator, every nesting level, every array length, and the
 * FORM of the identifiers, because "an urn that looks like an urn" is part of what
 * we are learning. And it has to keep no PEOPLE, because it goes into version
 * control and CLAUDE.md hard rule #9 keeps personal data on the EU server.
 *
 * So this replaces values and never structure:
 *
 *   - Identity-bearing values are replaced by shape-preserving placeholders. An
 *     urn stays an urn with the same segment count; a photo path keeps its
 *     directory depth; a name stays a name with accents in it, so the
 *     accent-folding tests still mean something.
 *   - Replacement is DETERMINISTIC and REFERENTIAL. The same input always maps to
 *     the same placeholder within a snapshot, so an urn referenced from three
 *     entries still ties them together. Without that the fixture could not teach
 *     us how the response cross-references itself, which is most of what an
 *     `included` array is.
 *   - Everything else is left exactly as it is. Keys are never renamed, types
 *     never change, arrays never shrink.
 *
 * ── WHAT COUNTS AS IDENTITY ─────────────────────────────────────────────────
 *
 * Decided by KEY NAME from a list, not by sniffing values. Sniffing would scrub
 * the schema — a `$type` of "com.linkedin.voyager.dash.identity.profile.Profile"
 * looks a lot like an identifier — and missing a key is a bug we can fix by
 * adding to the list, while corrupting the discriminators makes the snapshot
 * useless for its only purpose.
 */
(() => {
  /** Keys whose VALUE names a human, wherever they appear. */
  const NAME_KEYS = new Set([
    "firstname", "lastname", "fullname", "name", "displayname", "formattedname",
    "vanityname", "publicidentifier", "memberidentity", "profileid",
    "firstnameinitial", "lastnameinitial", "maidenname", "nickname",
  ]);

  /** Keys whose value is a contact detail. */
  const CONTACT_KEYS = new Set([
    "emailaddress", "email", "phonenumber", "number", "phone", "address",
    "birthdateon", "birthdate", "twitterhandle", "weixinhandle", "imaddress",
  ]);

  /** Keys whose value identifies a record or a session. */
  const ID_KEYS = new Set([
    "entityurn", "objecturn", "urn", "trackingid", "dashentityurn", "backendurn",
    "targeturn", "*profile", "profileurn", "miniprofileurn", "memberurn",
  ]);

  /** Keys holding an image path or the root it is joined to. */
  const IMAGE_KEYS = new Set([
    "rooturl", "fileidentifyingurlpathsegment", "vectorimage", "artifacts",
  ]);

  /**
   * Names used for replacement.
   *
   * Accented and self-evidently fake. "Anonimizált Ödön" has been the placeholder
   * since the DOM fixtures and stays, so a reader recognises a scrubbed file at a
   * glance and the accent-folding tests keep something to fold.
   */
  const OWNER = { first: "Ödön", last: "Anonimizált" };
  const OTHERS = [
    ["Elek", "Teszt"], ["Anna", "Példa"], ["Béla", "Minta"], ["Cecília", "Próba"],
    ["Dénes", "Fiktív"], ["Emese", "Álnév"], ["Ferenc", "Névtelen"], ["Gábor", "Ismeretlen"],
  ];

  const lower = (s) => String(s ?? "").toLowerCase();

  /**
   * A deterministic, referential replacer.
   *
   * One instance per snapshot. Every distinct input value gets the next
   * placeholder of its kind and is remembered, so the third mention of an urn is
   * the same placeholder as the first.
   */
  function createReplacer() {
    const seen = new Map();
    const counters = { name: 0, urn: 0, id: 0, image: 0, contact: 0 };

    const remember = (kind, original, make) => {
      const key = `${kind}::${original}`;
      if (seen.has(key)) return seen.get(key);
      counters[kind] += 1;
      const value = make(counters[kind]);
      seen.set(key, value);
      return value;
    };

    return {
      /**
       * A person's name, keyed by the PERSON rather than by the string.
       *
       * Keying on the value gave "Mark" and "Goldberger" two different identities,
       * so one human came out of the scrubber as two — which would have taught a
       * reader of the fixture that first and last names live on different records.
       * `personKey` is the entityUrn when the record has one, so every mention of
       * the same person anywhere in the response resolves to the same placeholder.
       *
       * The FIRST person seen is the profile's owner: the page is about them, so
       * theirs is the record that appears first and most.
       */
      person(personKey, hint) {
        const identity = remember("name", personKey, (n) =>
          n === 1
            ? OWNER
            : { first: OTHERS[(n - 2) % OTHERS.length][0], last: OTHERS[(n - 2) % OTHERS.length][1] },
        );
        const h = lower(hint);
        if (h.includes("first")) return identity.first;
        if (h.includes("last")) return identity.last;
        if (h.includes("initial")) return identity.first.slice(0, 1);
        if (h.includes("public") || h.includes("vanity")) {
          return `${identity.first}-${identity.last}`
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase();
        }
        return `${identity.first} ${identity.last}`;
      },

      /**
       * An urn, keeping its shape.
       *
       * `urn:li:fsd_profile:ACoAAB1234` becomes `urn:li:fsd_profile:AAAAAAAA001`:
       * same prefix, same segment count, same recognisable form, no member id. The
       * TYPE segment is preserved because it is schema, not identity.
       */
      urn(original) {
        return remember("urn", original, (n) => {
          const parts = String(original).split(":");
          if (parts.length >= 4 && parts[0] === "urn") {
            const tail = parts.slice(3).map((_, i) => (i === 0 ? `SCRUBBED${String(n).padStart(3, "0")}` : `p${i}`));
            return [parts[0], parts[1], parts[2], ...tail].join(":");
          }
          return `scrubbed-id-${String(n).padStart(3, "0")}`;
        });
      },

      id(original) {
        return remember("id", original, (n) => `scrubbed-id-${String(n).padStart(3, "0")}`);
      },

      /** An image path, keeping its directory depth and any size marker. */
      image(original) {
        return remember("image", original, (n) => {
          const s = String(original);
          if (/^https?:\/\//i.test(s)) {
            try {
              const u = new URL(s);
              return `${u.origin}/scrubbed/image-${String(n).padStart(3, "0")}/`;
            } catch {
              return `https://media.licdn.com/scrubbed/image-${String(n).padStart(3, "0")}/`;
            }
          }
          // A path segment such as "/D4E03AQH.../profile-displayphoto/" keeps its
          // depth, because the mapping has to learn how root and segment join.
          const depth = s.split("/").filter(Boolean).length;
          const segs = Array.from({ length: Math.max(depth, 1) }, (_, i) =>
            i === 0 ? `scrubbed-${String(n).padStart(3, "0")}` : `seg${i}`,
          );
          return `${s.startsWith("/") ? "/" : ""}${segs.join("/")}${s.endsWith("/") ? "/" : ""}`;
        });
      },

      contact(original, hint) {
        return remember("contact", original, (n) => {
          const h = lower(hint);
          if (h.includes("email")) return `person${n}@example.test`;
          if (h.includes("phone") || h.includes("number")) return `+3612345${String(n).padStart(4, "0")}`;
          if (h.includes("birth")) return "1900-01-01";
          return `scrubbed-contact-${n}`;
        });
      },
    };
  }

  const URN_SHAPED = /^urn:li:[a-zA-Z0-9_]+:.+/;

  /**
   * Walk a parsed body, replacing identity in place.
   *
   * Depth-limited rather than trusting the input to be finite: a hostile or merely
   * enormous response must not turn a developer action into a hang.
   */
  function scrubValue(value, key, replacer, depth = 0) {
    if (depth > 40) return value;
    if (value === null || value === undefined) return value;

    if (Array.isArray(value)) {
      return value.map((v) => scrubValue(v, key, replacer, depth + 1));
    }

    if (typeof value === "object") {
      /**
       * A record that names a human is scrubbed as ONE person.
       *
       * Its identity is keyed on the entityUrn where there is one, so the same
       * human appearing in three entries — which is normal in an `included` array
       * — resolves to the same placeholder in all three.
       */
      const keys = Object.keys(value);
      const namesSomebody = keys.some((k) => NAME_KEYS.has(lower(k).replace(/[^a-z*]/g, "")));
      const personKey = namesSomebody
        ? String(
            value.entityUrn ??
              value.objectUrn ??
              value.urn ??
              `${value.firstName ?? ""}|${value.lastName ?? ""}|${value.name ?? ""}`,
          )
        : null;

      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const flat = lower(k).replace(/[^a-z*]/g, "");
        if (personKey !== null && typeof v === "string" && NAME_KEYS.has(flat)) {
          // A schema string is never a name, whatever the key is called.
          out[k] = v.includes(".") && /^[a-z]+(\.[a-zA-Z]+)+$/.test(v)
            ? v
            : replacer.person(personKey, flat);
          continue;
        }
        out[k] = scrubValue(v, k, replacer, depth + 1);
      }
      return out;
    }

    if (typeof value !== "string" || value.length === 0) return value;

    const k = lower(key).replace(/[^a-z*]/g, "");

    // An urn anywhere, whatever the key is called.
    if (URN_SHAPED.test(value)) return replacer.urn(value);

    if (NAME_KEYS.has(k)) {
      // Reached only for a name outside any object — an array of bare strings.
      // Inside an object the branch above handles it, keyed by person.
      if (value.includes(".") && /^[a-z]+(\.[a-zA-Z]+)+$/.test(value)) return value;
      return replacer.person(`bare::${value}`, k);
    }
    if (CONTACT_KEYS.has(k)) return replacer.contact(value, k);
    if (ID_KEYS.has(k)) return replacer.id(value);
    if (IMAGE_KEYS.has(k) || /licdn\.com/i.test(value)) return replacer.image(value);

    return value;
  }

  /**
   * Scrub one observed record.
   *
   * The URL is kept — the PATTERN is what we are trying to learn — with its query
   * string reduced to parameter names. A query can carry a member id, and the
   * parameter names are the part that matters for recognising an endpoint.
   */
  function scrubRecord(record, replacer, knownSlugs = []) {
    let url = record.url;
    try {
      const u = new URL(record.url);
      const params = [...u.searchParams.keys()];
      url = `${u.origin}${u.pathname}${params.length ? `?${params.map((p) => `${p}=<scrubbed>`).join("&")}` : ""}`;
    } catch {
      url = String(record.url).split("?")[0];
    }
    /**
     * The PATH is identity too. `…/flagship-web/in/tom-vechy-vecsernyes/` came
     * through the first real snapshot untouched, because only the query string
     * was being scrubbed. The whole point of the file is that no person survives
     * it, and a slug is a person.
     */
    url = url
      .replace(MEMBER_ID, (m) => replacer.id(m))
      .replace(SLUG_IN_PATH, (_m, slug) => `/in/${replacer.person(`slug::${slug}`, "vanity")}`);

    let body = null;
    let parseError = null;
    let bodyFormat = null;
    if (typeof record.body === "string") {
      try {
        body = scrubValue(JSON.parse(record.body), "", replacer, 0);
        bodyFormat = "json";
      } catch {
        /**
         * NOT JSON — try the React Server Components wire format.
         *
         * This mattered a great deal. LinkedIn's profile moved onto RSC, whose
         * payload is numbered rows of JSON FRAGMENTS rather than one JSON
         * document. `JSON.parse` throws on it, and the old code stopped there:
         * `body` stayed null and the snapshot recorded a `parseError`.
         *
         * That failed SAFE — nothing personal was written to a file that goes
         * into version control, which is the property that matters most here —
         * but it also meant the snapshot carried nothing, so the payload could
         * not be studied or mapped. Both halves are needed: parsed enough to be
         * useful, scrubbed enough to be committable.
         */
        const rows = parseFlight(record.body, replacer, knownSlugs);
        if (rows) {
          body = rows;
          bodyFormat = "rsc-flight";
        } else {
          parseError = "NotJsonOrFlight";
        }
      }
    }

    return {
      url,
      method: record.method,
      status: record.status,
      contentType: record.contentType,
      bodySize: record.bodySize,
      truncated: !!record.truncated,
      // Which wire format the body turned out to be. The mapping needs to know:
      // an RSC row set is read differently from a JSON document.
      bodyFormat,
      parseError,
      body,
    };
  }

  /**
   * ── SCRUBBING AN RSC FLIGHT BODY: THE RULE IS INVERTED ──────────────────────
   *
   * Everywhere else in this file, identity is found by KEY — `firstName`,
   * `entityUrn`, `emailAddress`. On a flight body that does not work, and the
   * first real snapshot proved it beyond argument: 52 strangers' profile slugs,
   * 126 member ids, a live email address and 1351 name occurrences came through
   * a scrubber that was "working". The payload is React elements, so the keys are
   * `children`, `id` and `value`, and a person's name is a bare string sitting in
   * an array position:
   *
   *     row0[3].children[1][2][3].children[3]…children[1]  →  "/in/tom-…-…/overlay/"
   *     row0[3].children[1][0][0][3].modelStates[0].key.key.value.id
   *                                                    →  "profile-activity-load-tom-…"
   *
   * There is no key to key off. So for flight bodies the default flips: EVERY
   * string is redacted unless it matches a shape that is provably structure. A
   * census of a real 72 KB component response says what those shapes are —
   * 68% of its strings are structural, and none of them is a person:
   *
   *     React refs ($…)          359      camelCase tokens        477
   *     PascalCase tokens        102      kebab class names        52
   *     chunk hashes (32 hex)     11      com.linkedin.… ids        6
   *     urns                      15      numbers/punctuation      35
   *
   * The remaining 495 free-text strings are the names, headlines and signed
   * image paths. They become shape placeholders: `<text:12>`, `<email>`,
   * `<image:2>`. A field mapping needs to learn WHERE a value sits in the
   * structure, not what it said — and the path is preserved exactly.
   *
   * Erring toward redaction is the only defensible direction for a file that goes
   * into version control.
   */
  /**
   * A member id, bounded to its ACTUAL length.
   *
   * Measured, not guessed: in the first two real snapshots every id is exactly
   * 39 characters — `ACoAA` plus 34 — 156 occurrences of it, and every longer
   * match is that id with something glued on (`…95XkAbout`, `…95Xk_show_first`,
   * `…95XkContactInfoDetailSection`). An open-ended `{5,}` swallowed the suffix
   * too, which is safe but destroys a discriminator the mapping needs. Bounded,
   * the id goes and `ContactInfoDetailSection` stays.
   */
  const MEMBER_ID = /ACoAA[A-Za-z0-9_-]{34}/g;
  const SLUG_IN_PATH = /\/in\/([A-Za-z0-9][A-Za-z0-9%_-]{2,})/g;

  /** Shapes that are structure, established from a real payload's census. */
  const STRUCTURAL = [
    /^\$/, // React reference or element marker
    /^[0-9a-f]{32}$/, // webpack chunk hash
    /^com\.linkedin\.[\w.$]+$/, // sdui component and request ids
    // Up to 60, not 30: stripping a member id leaves its PLACEHOLDER glued to
    // the name it was concatenated with (`AAAAAAAA001ContactInfoDetailSection`),
    // and at 30 that came out as redacted text. Nothing 60 characters long and
    // camelCased is a person.
    /^[a-z][a-zA-Z0-9]{0,59}$/, // camelCase prop or enum value
    /^[A-Z][a-zA-Z0-9]{0,59}$/, // PascalCase component name
    // Numbers and punctuation — but SHORT ones only. "0.5x", "12", "1:1" are prop
    // values; `+36308902438` is a person's mobile, and it got through the first
    // version of this list because a phone number is also just digits and
    // punctuation. Seven digits is the line: below it there is no phone number,
    // and above it there is nothing a layout prop needs.
    /^(?=(?:\D*\d){0,6}\D*$)[\d.,%+\-: ]+$/,
    /^(static\/)?chunks?\/[\w./-]+$/, // build asset paths
  ];

  /**
   * Every string that SURVIVES still goes through this.
   *
   * A structural shape is not a promise of innocence: `profile-activity-load-tom-
   * vechy-vecsernyes` is a perfectly ordinary kebab token with a person's name
   * inside it, and a member id can be concatenated onto a component name
   * (`ACoAA…About` appeared in the real data). So slugs and member ids are
   * replaced inside anything we keep, by the same referential map, before the
   * shape test even runs.
   */
  function sanitiseKept(text, replacer, ident) {
    /**
     * The replacement is alphanumeric on purpose.
     *
     * `replacer.id()` yields `scrubbed-id-001`, and a member id is routinely
     * concatenated with a component name (`…95XkContactInfoDetailSection`). With
     * the hyphenated form spliced in, the result matched no structural shape and
     * the component name was redacted with it — a discriminator lost to the
     * SHAPE of a placeholder. `SCRUBBEDID001Contact…` still reads as one token.
     */
    let out = String(text).replace(MEMBER_ID, (m) =>
      replacer.id(m).replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    );
    for (const [slug, placeholder] of ident.slugs) {
      if (out.includes(slug)) out = out.split(slug).join(placeholder);
    }
    /**
     * A FIRST NAME ON ITS OWN.
     *
     * The real snapshot ended with `modelStates[7].value.stringValue: "Tom"`
     * surviving, because `Tom` is indistinguishable BY SHAPE from `Icon` or
     * `Header` — a short capitalised word. Shape-based scrubbing cannot tell
     * those apart, and that is a genuine limit of it.
     *
     * What saves it is that the name is DERIVABLE: the slug is in the payload,
     * and `tom-vechy-vecsernyes` spells out its own tokens. So each slug's parts
     * become redaction targets, matched as a whole string only — a class name
     * that merely contains one is handled by the slug replacement above.
     */
    const token = ident.tokens.get(out.trim().toLowerCase());
    return token ?? out;
  }

  /** A shape placeholder for text we will not keep. Says the kind and the size. */
  function placeholderFor(text) {
    if (text.length === 0) return "";
    /**
     * A `mailto:` or `tel:` URL keeps its scheme.
     *
     * The real contact panel carries the address inside a navigate action as
     * `mailto:someone@example.com`, not as a bare address — and without the
     * scheme surviving, the fixture showed `<text:24>` at that position and told
     * a reader nothing about what belongs there. The scheme is schema; the
     * address is the person.
     */
    const scheme = /^(mailto|tel):(.*)$/i.exec(text);
    if (scheme) return `${scheme[1].toLowerCase()}:<${scheme[1].toLowerCase() === "tel" ? "phone" : "email"}>`;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "<email>";
    // Character class ordered so `d` is never followed by `(`: the extension's
    // static checker reads that as a call to an undefined function `d`, and a
    // regex literal is not a call site.
    if (/^\+?\d[()\d \/-]{7,}$/.test(text)) return "<phone>";
    // Image paths keep their directory depth: the mapping has to learn how a root
    // and a path segment are joined to make a usable URL.
    if (/^[\w.-]+\/[\w./-]+\?/.test(text) || /displayphoto|profile-framedphoto|company-logo/.test(text)) {
      return `<image:${text.split("/").length}>`;
    }
    if (/^https?:\/\//.test(text)) return "<url>";
    if (text.startsWith("/")) return `<path:${text.split("/").filter(Boolean).length}>`;
    return `<text:${text.length}>`;
  }

  function scrubFlightValue(value, replacer, ident, depth = 0) {
    if (depth > 60) return "<depth-limit>";
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((v) => scrubFlightValue(v, replacer, ident, depth + 1));
    }
    if (typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        // The KEY is schema and is kept — but a key can carry a slug too.
        const key = sanitiseKept(k, replacer, ident);
        /**
         * A NUMERIC id is still an id.
         *
         * Numbers are otherwise kept untouched, because a number cannot be a
         * name — but `breadcrumbs[0].content.entityView.targetId: 614891950`
         * points at an entity as surely as a urn does. Here the key IS
         * meaningful (these are object properties, not React children), so a
         * key-based rule works where it could not for the strings.
         *
         * Small numbers are left alone: a `tabId: 3` or `columnId: 1` is layout.
         */
        if (typeof v === "number" && /(^|[a-z])(id|ids|urn|urns)$/i.test(key) && Math.abs(v) >= 10000) {
          out[key] = Number(replacer.id(String(v)).replace(/\D+/g, "") || 1);
          continue;
        }
        out[key] = scrubFlightValue(v, replacer, ident, depth + 1);
      }
      return out;
    }
    if (typeof value !== "string") return value;

    const clean = sanitiseKept(value, replacer, ident);
    if (URN_SHAPED.test(clean)) return replacer.urn(clean);
    for (const shape of STRUCTURAL) {
      if (shape.test(clean)) return clean;
    }
    // A kebab token is structure only while it is short: class names are, and a
    // three-word name joined by dashes is not.
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(clean) && clean.length <= 40) return clean;
    /**
     * A short token CONTAINING A DIGIT is a layout value — `0.5x`, `1:1`, `2x`,
     * `1a`. The digit is what makes this safe: a name does not have one, so this
     * rule cannot keep a `Tom` by accident. Without it these were redacted, which
     * cost the fixture its scale and ratio props for no gain.
     */
    if (clean.length <= 8 && /\d/.test(clean) && /^[\w.:%+-]+$/.test(clean)) return clean;
    return placeholderFor(clean);
  }

  /**
   * Every profile slug the body mentions, and the name tokens inside them.
   *
   * `slugs` replaces the slug wherever it appears, including inside a longer
   * composite string. `tokens` catches a name standing alone, which the slug
   * replacement cannot see and shape cannot judge.
   */
  function identityMapFor(text, replacer, extraSlugs = []) {
    const slugs = new Map();
    const tokens = new Map();
    /**
     * The body's own `/in/` paths, PLUS the slugs the caller already knows: the
     * record's url and the snapshot's subject.
     *
     * A regression test caught this. A body that never mentions a profile path
     * yielded no tokens at all, so a bare first name in a `stringValue` had
     * nothing to match against — and the name is only recoverable BECAUSE the
     * slug spells it out. Taking the slug from the url and the snapshot as well
     * means the tokens exist even when the body is a fragment.
     */
    const candidates = [
      ...[...String(text).matchAll(SLUG_IN_PATH)].map((m) => m[1]),
      ...extraSlugs,
    ];
    for (const slug of candidates) {
      if (!slug || slugs.has(slug)) continue;
      // "vanity" is the hint that asks for the slug FORM of a name, which is
      // exactly what a slug is — so a person's placeholder slug matches their
      // placeholder name elsewhere in the same snapshot.
      const placeholder = replacer.person(`slug::${slug}`, "vanity");
      slugs.set(slug, placeholder);
      const parts = placeholder.split("-");
      let i = 0;
      for (const part of decodeURIComponent(slug).split("-")) {
        // Two-letter fragments are initials and abbreviations, not names, and
        // redacting them would eat half the enum values in the payload.
        if (part.length >= 3) tokens.set(part.toLowerCase(), parts[i] ?? "<name>");
        i += 1;
      }
    }
    return {
      // Longest first, so a slug that is a prefix of another cannot half-replace it.
      slugs: new Map([...slugs.entries()].sort((a, b) => b[0].length - a[0].length)),
      tokens,
    };
  }

  /**
   * Parse an RSC flight body into scrubbed rows.
   *
   *     0:{"a":"$@1","b":"…"}          → { id: "0", tag: null, value: {…} }
   *     1:I[54321,["chunk.js"],"x"]    → { id: "1", tag: "I", value: [...] }
   *
   * Each row's fragment is scrubbed as JSON, so identity inside it is replaced by
   * the same referential rules as anywhere else — one human stays one human
   * across rows, which is most of what there is to learn from a payload that
   * cross-references itself.
   *
   * A row whose fragment does not parse keeps its id and tag and reports its
   * LENGTH, never its text: an unparsed fragment is exactly where a real name
   * would survive, and the whole point of this file is that none does.
   *
   * Returns null if nothing looked like a row, so the caller can say so.
   */
  function parseFlight(text, replacer, knownSlugs = []) {
    const lines = String(text).split("\n");
    // Every slug in the WHOLE body first, so one person keeps one placeholder
    // across every row that mentions them.
    const ident = identityMapFor(text, replacer, knownSlugs);
    const rows = [];
    let parsed = 0;
    for (const line of lines) {
      if (line.length === 0) continue;
      const m = /^([0-9a-f]{1,4}):([A-Za-z]?)([\s\S]*)$/.exec(line);
      if (!m) {
        rows.push({ id: null, tag: null, unparsedLength: line.length });
        continue;
      }
      const [, id, tag, payload] = m;
      try {
        rows.push({
          id,
          tag: tag || null,
          // The flight walker, NOT the key-based one: see the long note above.
          value: scrubFlightValue(JSON.parse(payload), replacer, ident, 0),
        });
        parsed += 1;
      } catch {
        rows.push({ id, tag: tag || null, unparsedLength: payload.length });
      }
    }
    // At least one real row, or this was not a flight body at all.
    return parsed > 0
      ? { format: "rsc-flight", rowCount: rows.length, slugsSeen: ident.slugs.size, rows }
      : null;
  }

  /** Scrub a whole page's worth of observations into one committable snapshot. */
  function scrubSnapshot({ slug, records, label, note }) {
    const replacer = createReplacer();
    return {
      snapshotVersion: 1,
      // The slug's SHAPE is the reproducer for a whole class of bug, so it is
      // preserved in form: token count and whether it is an abbreviation.
      slugShape: {
        tokens: String(slug ?? "").split("-").filter(Boolean).length,
        abbreviated: /^[a-z]{1,3}[a-z]{4,}$/.test(String(slug ?? "")) && !String(slug ?? "").includes("-"),
      },
      label: label ?? null,
      note: note ?? null,
      recordCount: records.length,
      /**
       * The slugs we already know, handed to every record.
       *
       * The subject of the snapshot, and whatever each record's own url names.
       * A name is only recoverable from a payload because the slug spells it
       * out, so the tokens have to exist even for a body that mentions no
       * profile path at all.
       */
      records: records.map((r) =>
        scrubRecord(r, replacer, [
          ...(slug ? [String(slug)] : []),
          ...[...String(r?.url ?? "").matchAll(SLUG_IN_PATH)].map((m) => m[1]),
        ]),
      ),
    };
  }

  globalThis.VentureApiScrub = { scrubSnapshot, scrubRecord, scrubValue, createReplacer };
})();
