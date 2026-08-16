/**
 * Every word on the public audit landing, in both languages.
 *
 * One typed dictionary rather than an i18n framework: at two languages and one
 * page, a catalogue format plus a routing integration buys nothing that
 * `Record<Locale, LandingCopy>` does not already give us — and this gives one
 * thing a framework cannot, which is that a MISSING TRANSLATION FAILS THE
 * BUILD. The failure mode of hand-rolled i18n is a blank space on a live page
 * in the language you do not read; TypeScript removes it here.
 *
 * Tone rules, applied throughout:
 *   - No claim the audit engine cannot back up. The "what we check" list is
 *     generated from the real category registry, not written here.
 *   - No social proof. There is none yet, and inventing it on a public page
 *     is not a thing we do.
 *   - Hungarian is the original; the English is a translation of intent, not
 *     of words. "Mennyit ér a weboldala?" is not "How much is your website
 *     worth?" — that reads as an appraisal service.
 */
import type { Locale } from "@/lib/locale";

export interface FaqItem {
  q: string;
  a: string;
}

export interface Step {
  title: string;
  body: string;
}

export interface LandingCopy {
  /** <title> and meta description. */
  metaTitle: string;
  metaDescription: string;

  hero: {
    headline: string;
    sub: string;
    inputLabel: string;
    inputPlaceholder: string;
    cta: string;
    ctaBusy: string;
    reassurance: string;
  };

  progress: {
    queued: string;
    running: string;
    scoring: string;
    note: string;
    slowNote: string;
    queuePosition: (n: number) => string;
  };

  steps: {
    eyebrow: string;
    title: string;
    items: [Step, Step, Step];
  };

  checks: {
    eyebrow: string;
    title: string;
    intro: string;
    /** Rendered after the category list. */
    footnote: string;
  };

  result: {
    eyebrow: string;
    scoreCaption: string;
    findingsTitle: string;
    screenshotsTitle: string;
    desktop: string;
    mobile: string;
    error: string;
  };

  unlock: {
    eyebrow: string;
    title: string;
    body: string;
    name: string;
    email: string;
    company: string;
    serviceConsent: string;
    marketingConsent: string;
    submit: string;
    submitBusy: string;
    success: string;
    successBody: string;
    validationEmail: string;
    validationConsent: string;
  };

  privacy: {
    eyebrow: string;
    title: string;
    body: string;
    bullets: [string, string, string];
  };

  faq: {
    eyebrow: string;
    title: string;
    items: FaqItem[];
  };

  footer: {
    contact: string;
    switchLabel: string;
  };
}

const hu: LandingCopy = {
  metaTitle: "Ingyenes weboldal-átvilágítás",
  metaDescription:
    "Mennyit ér a weboldala? Gépi átvilágítás egy perc alatt: sebesség, mobilnézet, megtalálhatóság, jogi megfelelés. Regisztráció nélkül.",

  hero: {
    headline: "mennyit ér a weboldala?",
    sub: "Ingyenes átvilágítás egy perc alatt. Sebesség, mobilnézet, megtalálhatóság, jogi megfelelés — gépi mérés, marketingszöveg nélkül.",
    inputLabel: "A weboldal címe",
    inputPlaceholder: "pelda.hu",
    cta: "Átvilágítás indítása",
    ctaBusy: "Fut…",
    reassurance: "Nem kérünk regisztrációt. Az eredményt azonnal látja.",
  },

  progress: {
    queued: "Sorban áll",
    running: "Betöltjük az oldalt egy böngészőben",
    scoring: "Pontozás és képernyőképek",
    note: "Az oldalt egy valódi böngészőben töltjük be, és mobilon is megnézzük.",
    slowNote:
      "Még dolgozunk rajta — a lassú oldalak átvilágítása tart tovább, ez önmagában is információ.",
    queuePosition: (n) => `${n}. a sorban — mindjárt sorra kerül.`,
  },

  steps: {
    eyebrow: "Hogyan működik",
    title: "három lépés, semmi bonyolult",
    items: [
      {
        title: "Megadja a címet",
        body: "Elég a domain. Nem kell hozzáférés, jelszó vagy bármit telepíteni az oldalra.",
      },
      {
        title: "Megnézzük a gépünkkel",
        body: "Egy valódi böngésző betölti az oldalt asztali és mobil nézetben, és lefuttatunk rajta több tucat mérést. Ez általában fél perc.",
      },
      {
        title: "Megkapja az eredményt",
        body: "A pontszámot és a legfontosabb megállapításokat rögtön látja. A részletes riportot e-mailben küldjük, ha kéri.",
      },
    ],
  },

  checks: {
    eyebrow: "Mit nézünk meg",
    title: "amit egy látogató és egy kereső is lát",
    intro:
      "Minden mérés gépi és ellenőrizhető. Nincs benne szubjektív értékelés, és nincs benne semmi, amit ne tudnánk megmutatni.",
    footnote:
      "A pontszám azt mutatja, mennyi javítanivaló van — a magasabb szám több lehetőséget jelent, nem jobb oldalt.",
  },

  result: {
    eyebrow: "Eredmény",
    scoreCaption: "javítanivaló pontszám",
    findingsTitle: "A három legfontosabb megállapítás",
    screenshotsTitle: "Így néz ki az oldal",
    desktop: "Asztali nézet",
    mobile: "Mobil nézet",
    error:
      "Nem sikerült betölteni az oldalt. Elérhető egyáltalán? Próbálja újra, vagy írjon nekünk.",
  },

  unlock: {
    eyebrow: "Teljes riport",
    title: "kérem a részletes riportot",
    body: "A teljes riport minden mérést tartalmaz kategóriánként, képernyőképekkel és javasolt sorrenddel — PDF-ben, e-mailben.",
    name: "Név",
    email: "E-mail cím",
    company: "Cég neve",
    serviceConsent: "Kérem a teljes riportot e-mailben.",
    // `{brand}` is replaced with the workspace's own name at render. The
    // controller named in a consent record has to be the company actually
    // collecting the data — naming a different one makes the record wrong in
    // the way that matters (audit-v2 item 6).
    marketingConsent:
      "Hozzájárulok, hogy a {brand} a riport eredményei kapcsán megkeressen. Ezt bármikor visszavonhatom.",
    submit: "Riport kérése",
    submitBusy: "Küldjük…",
    success: "Elküldtük.",
    successBody:
      "A riport néhány percen belül megérkezik. Ha nem látja, nézze meg a levélszemét mappát is.",
    validationEmail: "Adjon meg egy működő e-mail címet.",
    validationConsent: "A riport küldéséhez pipálja be az első jelölőnégyzetet.",
  },

  privacy: {
    eyebrow: "Adatkezelés",
    title: "mit tárolunk, és meddig",
    body: "Röviden: a megadott weboldal címét és a mérés eredményét. Ha kéri a riportot, a megadott elérhetőségeit is — azért, hogy elküldhessük.",
    bullets: [
      "A mérés eredményét 30 napig tartjuk meg, utána törlődik.",
      "Az e-mail címét csak akkor használjuk megkereséshez, ha ehhez külön hozzájárult.",
      "Bármikor kérheti az adatai törlését egyetlen e-mailben.",
    ],
  },

  faq: {
    eyebrow: "Gyakori kérdések",
    title: "amit meg szoktak kérdezni",
    items: [
      {
        q: "Tényleg ingyenes?",
        a: "Igen. Nincs próbaidőszak és nem kérünk bankkártyát. Azért csináljuk, mert a legtöbb megkeresésünk így kezdődik: valaki megnézi a saját oldalát, és meglepődik.",
      },
      {
        q: "Módosítanak bármit az oldalamon?",
        a: "Nem. Csak megnyitjuk, ahogy egy látogató tenné. Semmit nem írunk, nem töltünk fel és nem telepítünk.",
      },
      {
        q: "Ki látja az eredményt?",
        a: "Mi. Nem tesszük közzé, és nem adjuk tovább senkinek. Ha nem kéri a riportot, az e-mail címét meg sem adta.",
      },
      {
        q: "Mennyire pontos?",
        a: "A mérések gépiek, tehát ismételhetők — ugyanaz az oldal ugyanazt az eredményt adja. Nem helyettesíti a szakértői átnézést, de megmutatja, hol érdemes elkezdeni.",
      },
      {
        q: "Mi van, ha nincs is weboldalam?",
        a: "Akkor ez az eszköz nem sokat segít, de a beszélgetés annál inkább. Írjon nekünk.",
      },
    ],
  },

  footer: {
    contact: "Kérdése van? Válaszoljon erre az oldalra megadott címre.",
    switchLabel: "English",
  },
};

const en: LandingCopy = {
  metaTitle: "Free website audit",
  metaDescription:
    "What shape is your website in? A machine audit in about a minute: speed, mobile, findability, legal compliance. No sign-up.",

  hero: {
    headline: "what shape is your website in?",
    sub: "A free audit in about a minute. Speed, mobile layout, findability, legal compliance — measured, not marketed.",
    inputLabel: "Website address",
    inputPlaceholder: "example.com",
    cta: "Run the audit",
    ctaBusy: "Running…",
    reassurance: "No sign-up. You see the result immediately.",
  },

  progress: {
    queued: "Queued",
    running: "Loading your site in a browser",
    scoring: "Scoring and screenshots",
    note: "We load the page in a real browser and look at it on a phone too.",
    slowNote:
      "Still working — slow sites take longer to audit, which is itself a finding.",
    queuePosition: (n) => `Position ${n} in the queue — nearly there.`,
  },

  steps: {
    eyebrow: "How it works",
    title: "three steps, nothing to install",
    items: [
      {
        title: "Give us the address",
        body: "The domain is enough. No access, no password, nothing to install on your site.",
      },
      {
        title: "We look at it properly",
        body: "A real browser loads the page on desktop and mobile, and we run dozens of measurements over it. Usually about thirty seconds.",
      },
      {
        title: "You get the result",
        body: "The score and the most important findings appear straight away. The detailed report goes to your inbox if you want it.",
      },
    ],
  },

  checks: {
    eyebrow: "What we check",
    title: "what a visitor and a search engine both see",
    intro:
      "Every measurement is machine-made and verifiable. No subjective grading, and nothing we cannot show you.",
    footnote:
      "The score counts what is worth fixing — a higher number means more opportunity, not a better site.",
  },

  result: {
    eyebrow: "Result",
    scoreCaption: "opportunity score",
    findingsTitle: "The three findings that matter most",
    screenshotsTitle: "How the site looks",
    desktop: "Desktop",
    mobile: "Mobile",
    error: "We could not load that page. Is it reachable? Try again, or write to us.",
  },

  unlock: {
    eyebrow: "Full report",
    title: "send me the detailed report",
    body: "The full report covers every measurement by category, with screenshots and a suggested order of work — as a PDF, by email.",
    name: "Name",
    email: "Email address",
    company: "Company",
    serviceConsent: "Send me the full report by email.",
    marketingConsent:
      "I agree that {brand} may contact me about the findings in this report. I can withdraw this at any time.",
    submit: "Send the report",
    submitBusy: "Sending…",
    success: "On its way.",
    successBody:
      "The report arrives within a few minutes. If you cannot see it, check your spam folder.",
    validationEmail: "Please enter a working email address.",
    validationConsent: "Tick the first box so we can send the report.",
  },

  privacy: {
    eyebrow: "Privacy",
    title: "what we store, and for how long",
    body: "Briefly: the address you gave us and the result of the measurement. If you ask for the report, your contact details too — so that we can send it.",
    bullets: [
      "The audit result is kept for 30 days, then deleted.",
      "We only use your email address to contact you if you separately agreed to that.",
      "You can ask us to delete your data at any time, in one email.",
    ],
  },

  faq: {
    eyebrow: "Questions",
    title: "what people ask",
    items: [
      {
        q: "Is it really free?",
        a: "Yes. No trial, no card. We do it because most of our conversations start this way: someone looks at their own site and is surprised.",
      },
      {
        q: "Do you change anything on my site?",
        a: "No. We only open it, the way a visitor would. We write nothing, upload nothing and install nothing.",
      },
      {
        q: "Who sees the result?",
        a: "We do. We do not publish it and we do not pass it on. If you do not ask for the report, you never gave us your email at all.",
      },
      {
        q: "How accurate is it?",
        a: "The measurements are machine-made and therefore repeatable — the same site gives the same result. It does not replace an expert review, but it shows you where to start.",
      },
      {
        q: "What if I do not have a website?",
        a: "Then this tool will not help much, but the conversation will. Write to us.",
      },
    ],
  },

  footer: {
    contact: "Questions? Reply to the address on this page.",
    switchLabel: "Magyar",
  },
};

export const LANDING_COPY: Record<Locale, LandingCopy> = { hu, en };

/**
 * Fill the brand placeholders in a copy deck.
 *
 * Only the consent line carries one today, and it is the one that must: the
 * controller a prospect consents to has to be the company collecting their
 * data. Applied at render rather than baked in, so the STORED consent text
 * version stays comparable across workspaces.
 */
export function withBrand(copy: LandingCopy, brandName: string): LandingCopy {
  const fill = (s: string) => s.replace(/\{brand\}/g, brandName);
  return {
    ...copy,
    unlock: { ...copy.unlock, marketingConsent: fill(copy.unlock.marketingConsent) },
  };
}

export function copyFor(locale: Locale): LandingCopy {
  return LANDING_COPY[locale];
}
