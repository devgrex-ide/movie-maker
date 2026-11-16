import type { StoryModelAdapter } from "../adapters.js";
import { replacePublicFigures } from "../scan.js";
import type { DialogueLine, SceneBeat, StoryDraft, StoryJobInput } from "../types.js";

const OFFSCREEN = ["Helene Voss", "Carl Ibanez", "Paul Ortega", "Nina Cho", "Ellis Ward", "Jonah Pike"];
const ON_SCREEN = ["Mara Ellison", "Ruth Calder", "Jonah Pike", "Helen Voss", "Ellis Ward", "Nina Cho"];

const LOCATIONS: { test: RegExp; room: string; prop: string }[] = [
  { test: /clock/i, room: "THE CLOCK ROOM", prop: "the open clock" },
  { test: /mill|factory/i, room: "THE CLOSED MILL", prop: "the mill key" },
  { test: /diner|cafe|restaurant/i, room: "THE DINER", prop: "the last cup" },
  { test: /train|station/i, room: "THE STATION", prop: "the paper ticket" },
  { test: /harbor|boat|shore|sea|ocean/i, room: "THE HARBOR OFFICE", prop: "the tide book" },
  { test: /letter|mail/i, room: "THE FRONT ROOM", prop: "the unopened letter" },
  { test: /radio/i, room: "THE RADIO ROOM", prop: "the radio" },
  { test: /road|drive|car|highway/i, room: "THE NIGHT ROAD", prop: "the folded map" },
  { test: /office|work/i, room: "THE OFFICE", prop: "the ledger" },
  { test: /kitchen|apartment|home|house/i, room: "THE KITCHEN", prop: "the chair by the window" },
];

const BEATS: { act: number; slug: string; time: string; place: "room" | "threshold" | "night" }[] = [
  { act: 1, slug: "OPENING", time: "DAY", place: "room" },
  { act: 1, slug: "THE DAY AS IT IS", time: "DAY", place: "room" },
  { act: 1, slug: "WHAT ARRIVES", time: "DAY", place: "threshold" },
  { act: 1, slug: "THE ARGUMENT WITH THE WORK", time: "DUSK", place: "room" },
  { act: 2, slug: "STAYING", time: "NIGHT", place: "night" },
  { act: 2, slug: "THE LONG MIDDLE", time: "DAY", place: "room" },
  { act: 2, slug: "HALFWAY", time: "DAY", place: "threshold" },
  { act: 2, slug: "PRESSURE", time: "DUSK", place: "room" },
  { act: 2, slug: "THE EMPTY HOUR", time: "NIGHT", place: "night" },
  { act: 3, slug: "BEFORE DAWN", time: "NIGHT", place: "night" },
  { act: 3, slug: "THE LAST ATTEMPT", time: "DAWN", place: "room" },
  { act: 3, slug: "THE ENDING", time: "DAY", place: "threshold" },
];

/**
 * Local story adapter. It writes the package from the short story and the
 * anonymous cast envelope. It never receives a legal name, a face, or a reference.
 */
export class LocalStoryAdapter implements StoryModelAdapter {
  readonly id = "local-story-v1";

  writePackage(input: StoryJobInput): StoryDraft {
    const fictionalized = replacePublicFigures(input.shortStory.trim(), OFFSCREEN);
    const premise = fictionalized.text.replace(/\s+/g, " ").trim();
    const place = LOCATIONS.find((item) => item.test.test(premise)) ?? {
      room: "THE WORKROOM",
      prop: "the unfinished object",
    };
    const rooms = [place.room, `THE THRESHOLD OUTSIDE ${place.room}`, `${place.room} AT NIGHT`];
    const names = assignNames(premise, input.slots.length);
    const clause = premise.length > 280 ? `${premise.slice(0, 277)}…` : premise;
    const ending =
      "The ending keeps the premise: the adult stays with the work and says the true thing out loud.";

    const scenes: SceneBeat[] = BEATS.map((beat, index) => {
      const location = beat.place === "room" ? rooms[0] : beat.place === "threshold" ? rooms[1] : rooms[2];
      const action = sceneAction(beat.slug, names, clause, place.prop, location);
      return {
        index,
        act: beat.act,
        heading: beat.slug,
        location: location ?? place.room,
        timeOfDay: beat.time,
        action,
        want: wantFor(index, names[0] ?? "The adult", place.prop),
      };
    });

    const dialogue = scenes.flatMap((scene) => linesFor(scene, names, clause, place.prop));
    const fullStory = writeProse(input.projectTitle, names, clause, scenes, place.prop, ending, fictionalized.substitutions);
    const script = writeScript(input.projectTitle, names, scenes);
    const screenplay = writeScreenplay(scenes, dialogue, names);

    return {
      fullStory,
      script,
      screenplay,
      dialogue,
      scenes,
      characters: names.map((name, slotIndex) => ({ name, slotIndex })),
      substitutions: fictionalized.substitutions,
      bible: {
        style: "stylized",
        styleNote:
          "Stylized color and hard shadow, chosen so a face can hold across a few hundred short shots. Live action is not this release.",
        wardrobe: "One costume for the whole picture: charcoal coat, cream shirt. It does not change.",
        light: "One source from frame-left. Warm practical. The look stays inside the scene.",
        screenDirection: "Entrances face frame-right. Coverage keeps that axis.",
        props: `${place.prop} is in every scene. Hands may touch it. The face that reads is the consented adult.`,
        rooms,
        premise: clause,
        ending,
      },
    };
  }
}

function assignNames(premise: string, slotCount: number): string[] {
  const extracted = extractNames(premise);
  const names: string[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    names.push(extracted[i] ?? ON_SCREEN[i] ?? `Adult ${i + 1}`);
  }
  return names;
}

function extractNames(premise: string): string[] {
  const stop = new Set(
    "The A An After When Then She He They And But In On At For With From Into Over Under Before During While Once Two One His Her Their Monday Tuesday Wednesday Thursday Friday Saturday Sunday Sunday".split(
      " ",
    ),
  );
  const found = premise.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) ?? [];
  const names: string[] = [];
  for (const candidate of found) {
    const first = candidate.split(" ")[0] ?? candidate;
    if (stop.has(first)) continue;
    if (names.includes(candidate)) continue;
    names.push(candidate);
  }
  return names;
}

function sceneAction(slug: string, names: string[], clause: string, prop: string, location: string): string {
  const lead = names[0] ?? "The adult";
  const other = names[1];
  const withOther = other ? `${lead} and ${other} share the setup.` : `${lead} is the only face. Any other person in the premise stays off screen and is not given a likeness.`;
  return `${slug}. ${location}. ${withOther} The premise holds: ${clause} ${prop} stays in frame as the hero prop.`;
}

function wantFor(index: number, lead: string, prop: string): string {
  if (index < 4) return `${lead} wants to pretend the day can stay as it is.`;
  if (index < 9) return `${lead} wants to keep ${prop} from being abandoned.`;
  return `${lead} wants to finish the day in the open, with the premise intact.`;
}

function linesFor(scene: SceneBeat, names: string[], clause: string, prop: string): DialogueLine[] {
  const lead = names[0] ?? "Mara Ellison";
  const other = names[1];
  const short = clause.length > 140 ? `${clause.slice(0, 137)}…` : clause;
  const pair: { character: string; text: string }[] = [
    { character: lead, text: `I know the situation. ${short}` },
    {
      character: other ?? lead,
      text: other ? `Then we stay with ${prop}. We do not invent a different ending.` : `Then I stay with ${prop}. I do not invent a different ending.`,
    },
  ];
  if (scene.index % 3 === 2) {
    pair.push({
      character: lead,
      text: `Look at ${prop}. The room is the same. I am still the one who has to say it.`,
    });
  }
  return pair.map((line, lineIndex) => ({
    id: `dlg-${scene.index}-${lineIndex}`,
    sceneIndex: scene.index,
    character: line.character,
    text: line.text,
  }));
}

function writeProse(
  title: string,
  names: string[],
  clause: string,
  scenes: SceneBeat[],
  prop: string,
  ending: string,
  substitutions: { from: string; to: string }[],
): string {
  const lead = names[0] ?? "Mara Ellison";
  const castLine =
    names.length === 1
      ? `${lead} is the only person on screen.`
      : `${names.join(" and ")} are the people on screen.`;
  const replaced =
    substitutions.length === 0
      ? ""
      : "A public figure named in the source was changed to a fictional character. The picture uses the fictional character and does not request that likeness.";
  const paragraphs = [
    `${title}. The production supplied one short story and no script. The premise, kept whole, is this: ${clause}`,
    `${castLine} ${replaced} The picture uses few rooms, one wardrobe, and ${prop} as the object the camera can find again. The runtime is a feature film. The shots that will carry it are short.`,
    ...scenes.map((scene) => {
      return `Act ${scene.act}, ${scene.heading}. ${scene.location}, ${scene.timeOfDay}. ${scene.action} What ${lead} wants here: ${scene.want}`;
    }),
    ending,
    `The relationship in the premise remains. People who are not in the cast are heard as situation, or left outside the frame. The camera does not invent an extra face to fill a crowd.`,
  ];
  return paragraphs.filter(Boolean).join("\n\n");
}

function writeScript(title: string, names: string[], scenes: SceneBeat[]): string {
  const lines = [`${title.toUpperCase()}`, "", "Dramatic blueprint. Three acts. The writer of record is the story adapter.", ""];
  for (const scene of scenes) {
    if (scene.index === 0 || scenes[scene.index - 1]?.act !== scene.act) {
      lines.push(`ACT ${["", "ONE", "TWO", "THREE"][scene.act]}`, "");
    }
    lines.push(
      `Scene ${scene.index + 1}. ${scene.location} — ${scene.timeOfDay}`,
      `On screen: ${names.join(", ")}`,
      `What happens: ${scene.action}`,
      `Want: ${scene.want}`,
      "",
    );
  }
  return lines.join("\n");
}

function writeScreenplay(scenes: SceneBeat[], dialogue: DialogueLine[], names: string[]): string {
  const chunks: string[] = [];
  for (const scene of scenes) {
    chunks.push(`INT. ${scene.location} - ${scene.timeOfDay}`);
    chunks.push("");
    chunks.push(scene.action);
    chunks.push("");
    const lines = dialogue.filter((line) => line.sceneIndex === scene.index);
    for (const line of lines) {
      chunks.push(line.character.toUpperCase());
      chunks.push(line.text);
      chunks.push("");
    }
    if (names.length === 1) {
      chunks.push(`The frame holds ${names[0]}. Empty doorways stay empty.`);
      chunks.push("");
    }
  }
  return chunks.join("\n");
}
