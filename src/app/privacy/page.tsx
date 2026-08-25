import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Adatkezelési tájékoztató — látogatottsági mérés",
  robots: { index: false, follow: false },
};

/**
 * The page the notice line links to (playbook-v3 P8/e).
 *
 * Deliberately about ONE thing: the measurement on our public pages. It is not
 * the company's full privacy policy and does not pretend to be — a page that
 * tries to cover everything is a page nobody reads, and the visitor arrived
 * here from a single sentence about a single subject.
 */
const SECTIONS: Array<{ q: string; a: string[] }> = [
  {
    q: "Mit mérünk?",
    a: [
      "Az oldal megnyitását, azt hogy honnan érkezett (hivatkozó oldal), mobilon vagy asztali gépen nézi, mennyi ideig volt nyitva, meddig görgetett, és hogy az oldal mely szakaszainál időzött.",
      "Ez a mérés kizárólag azokon az oldalakon fut, amelyeket mi magunk adtunk ki: átvilágítási riport, árajánlat, időpontfoglaló.",
    ],
  },
  {
    q: "Használnak sütiket?",
    a: [
      "Nem. Egyetlen sütit sem helyezünk el. Az egy látogatáson belüli összetartozást egy véletlen azonosító biztosítja, amelyet a böngésző a lap bezárásakor eldob (sessionStorage).",
      "Mivel nincs süti és nincs harmadik fél, a mérés nem igényel hozzájárulási sávot — de ez a tájékoztató minden mért oldalról egy kattintásra elérhető.",
    ],
  },
  {
    q: "Mi történik az IP-címmel?",
    a: [
      "Az IP-címet legfeljebb 24 óráig őrizzük meg, egyetlen célból: megkíséreljük megállapítani, melyik CÉG hálózatáról érkezett a látogatás. Ez fordított DNS-lekérdezés, a látogató személyét nem érinti.",
      "A 24 óra letelte után a cím törlődik. Ami megmarad: egy visszafejthetetlen, sózott lenyomat, és maga a cég-találat, ha volt.",
    ],
  },
  {
    q: "Azonosítanak engem?",
    a: [
      "Nem. A találat mindig cég szintű, soha nem személy szintű, és soha nem tényként kezeljük: ahol nem teljesen biztos, ott „valószínűleg” szerepel.",
      "A látogatók többségénél — jellemzően lakossági internetkapcsolatról — semmilyen cég nem állapítható meg, és ilyenkor „azonosítatlan látogató” marad a bejegyzés.",
    ],
  },
  {
    q: "Ha nem szeretném, hogy mérjenek",
    a: [
      "Ha a böngészője Do Not Track (DNT) vagy Global Privacy Control (GPC) jelzést küld, azt tiszteletben tartjuk: ilyenkor egyetlen megtekintés ténye rögzül, más semmi — se időtartam, se görgetés, se IP-cím, még lenyomat formájában sem.",
    ],
  },
  {
    q: "Meddig őrzik meg?",
    a: [
      "A látogatás részletei 90 napig maradnak meg, utána már csak összesített darabszám marad.",
      "Ha egy hozzánk tartozó kapcsolattartó törlését kéri, a hozzá köthető látogatási adatok a törléssel együtt megsemmisülnek.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="relative z-10 min-h-screen">
      <div className="mx-auto max-w-[680px] px-5 py-14">
        <h1 className="mb-2 font-display text-[26px] font-extrabold lowercase tracking-display">
          látogatottsági mérés
        </h1>
        <p className="mb-9 text-[13px] leading-relaxed text-muted">
          Ez a tájékoztató arról szól, mit mérünk a nyilvános oldalainkon, és mit
          nem. Egy oldal, egy témáról.
        </p>

        <div className="grid gap-5">
          {SECTIONS.map((s) => (
            <section key={s.q} className="rounded-card border border-line bg-panel p-6">
              <h2 className="mb-2.5 font-display text-[16px] font-bold lowercase">
                {s.q.toLowerCase()}
              </h2>
              {s.a.map((line, i) => (
                <p key={i} className="mb-2 text-[13px] leading-relaxed text-[#C9CEE4] last:mb-0">
                  {line}
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
