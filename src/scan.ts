/**
 * Source and package scans. A hit stops the job before any picture exists.
 * The scanner is a backstop. Face conditioning still accepts only a bound consent pack.
 */

const MINOR_WORDS =
  /\b(children|child|kids|kid|toddlers|toddler|infants|infant|babies|baby|newborns|newborn|minors|minor|underage|preteens|preteen|pre-teens|pre-teen|adolescents|adolescent|teenagers|teenager|teens|teen|schoolboys|schoolboy|schoolgirls|schoolgirl|schoolchildren|schoolchild|kindergartners|kindergartener|preschoolers|preschooler|childhood|classmate|playground)\b/i;

const YOUNG_PERSON =
  /\b(little|small|young)\s+(boys|boy|girls|girl|sons|son|daughters|daughter)\b/i;

const UNDER_EIGHTEEN = /\bunder\s+(?:18|eighteen)\b/i;

const AGE_PATTERNS = [
  /\b(\d{1,2})\s*[- ]?(?:year|yr)s?[- ]old\b/gi,
  /\b(\d{1,2})\s+years?\s+old\b/gi,
  /\bage(?:d)?\s+(\d{1,2})\b/gi,
  /\b(?:is|was|turned)\s+(\d{1,2})\b(?!\s*(?:minutes?|hours?|seconds?|days?|weeks?|months?|years?|percent|%))/gi,
];

const SCHOOL = /\b(high school|middle school|elementary school|grade school)\b/i;

const SEXUAL =
  /\b(porn|pornography|nude|nudity|naked|sex scene|sexual|erotic|intercourse|orgasm|fetish)\b/i;

/**
 * Full names and a few mononyms that would otherwise be used as likenesses.
 * The story model replaces these with fictional characters.
 */
export const PUBLIC_FIGURES = [
  "Tom Hanks",
  "Taylor Swift",
  "Barack Obama",
  "Donald Trump",
  "Elon Musk",
  "Beyoncé",
  "Beyonce",
  "Leonardo DiCaprio",
  "Kim Kardashian",
  "Joe Biden",
  "Oprah Winfrey",
  "Rihanna",
  "Dwayne Johnson",
  "Ariana Grande",
  "Brad Pitt",
  "Angelina Jolie",
  "Johnny Depp",
  "Will Smith",
  "Scarlett Johansson",
  "Chris Hemsworth",
  "Timothée Chalamet",
  "Timothee Chalamet",
  "Morgan Freeman",
  "Meryl Streep",
  "Keanu Reeves",
  "Lady Gaga",
  "Kanye West",
  "Michael Jordan",
  "LeBron James",
  "Lebron James",
  "Cristiano Ronaldo",
  "Lionel Messi",
  "Greta Thunberg",
  "Vladimir Putin",
  "Volodymyr Zelensky",
  "Kamala Harris",
  "Hillary Clinton",
  "Bill Clinton",
  "George Clooney",
  "Natalie Portman",
  "Emma Watson",
  "Daniel Radcliffe",
  "Tom Cruise",
  "Margot Robbie",
  "Ryan Gosling",
  "Harry Styles",
  "Selena Gomez",
  "Justin Bieber",
  "Kylie Jenner",
  "Robert Downey",
  "Zendaya",
  "Adele",
  "Drake",
  "Eminem",
];

export interface ScanHit {
  kind: "minor" | "depiction" | "public_figure";
  term: string;
}

export function scanForMinors(text: string): ScanHit | null {
  const word = text.match(MINOR_WORDS) ?? text.match(YOUNG_PERSON) ?? text.match(UNDER_EIGHTEEN) ?? text.match(SCHOOL);
  if (word) return { kind: "minor", term: word[0] };
  for (const pattern of AGE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const age = Number(match[1]);
      if (age < 18) return { kind: "minor", term: match[0] };
    }
  }
  return null;
}

export function scanForDeniedDepiction(text: string): ScanHit | null {
  const match = text.match(SEXUAL);
  if (!match) return null;
  return { kind: "depiction", term: match[0] };
}

export function findPublicFigures(text: string): string[] {
  const found: string[] = [];
  for (const name of PUBLIC_FIGURES) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

export function replacePublicFigures(
  text: string,
  fictionalNames: string[],
): { text: string; substitutions: { from: string; to: string }[] } {
  let next = text;
  const substitutions: { from: string; to: string }[] = [];
  let index = 0;
  const figures = [...PUBLIC_FIGURES].sort((a, b) => b.length - a.length);
  for (const name of figures) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (!pattern.test(next)) continue;
    pattern.lastIndex = 0;
    const to = fictionalNames[index % fictionalNames.length] ?? "Alex Moreau";
    index += 1;
    if (!substitutions.some((item) => item.from.toLowerCase() === name.toLowerCase())) {
      substitutions.push({ from: name, to });
    }
    next = next.replace(pattern, to);
  }
  return { text: next, substitutions };
}
