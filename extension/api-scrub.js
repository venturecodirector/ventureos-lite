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
  function scrubRecord(record, replacer) {
    let url = record.url;
    try {
      const u = new URL(record.url);
      const params = [...u.searchParams.keys()];
      url = `${u.origin}${u.pathname}${params.length ? `?${params.map((p) => `${p}=<scrubbed>`).join("&")}` : ""}`;
    } catch {
      url = String(record.url).split("?")[0];
    }

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
        const rows = parseFlight(record.body, replacer);
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
  function parseFlight(text, replacer) {
    const lines = String(text).split("\n");
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
          value: scrubValue(JSON.parse(payload), "", replacer, 0),
        });
        parsed += 1;
      } catch {
        rows.push({ id, tag: tag || null, unparsedLength: payload.length });
      }
    }
    // At least one real row, or this was not a flight body at all.
    return parsed > 0 ? { format: "rsc-flight", rowCount: rows.length, rows } : null;
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
      records: records.map((r) => scrubRecord(r, replacer)),
    };
  }

  globalThis.VentureApiScrub = { scrubSnapshot, scrubRecord, scrubValue, createReplacer };
})();
