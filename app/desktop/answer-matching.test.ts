import { expect, it } from "vitest";
import type { DocumentParseResult, Question } from "../src/contracts.generated.js";
import { associatedQuestion, matchAnswers, printedNumber } from "./answer-matching.js";
import { validateParsedQuestion } from "./question-contract.js";
const question = (values: Record<string, unknown> = {}) => validateParsedQuestion({ stem: "Unnumbered", answerMode: "short_answer", ...values });
const document = (questions: Question[]): DocumentParseResult => ({ schemaVersion: 3, questions, groups: [], visualElements: [], warnings: [], missingFields: [], confidenceScore: 0 });
it.each([
  ["1. First","7. Fallback","1"],
  ["001、First","7. Fallback","1"],
  ["第 12 题：内容","7. Fallback","12"],
  ["42\r\nFirst","7. Fallback","42"],
  ["3.5 kg","7. Fallback","7"],
  ["3．５ kg","7. Fallback","7"],
  ["Unnumbered","7. Fallback","7"],
  ["1234567. Large","7. Fallback","7"],
  ["1. First\n2. Second","7. Fallback","1"],
  ["﻿1. BOM","7. Fallback","7"],
  ["1","7. Fallback","1"],
  ["1","7. Fallback","1"],
  ["1: First","7. Fallback","1"],
  ["2 word without separator","7. Fallback","7"]
])("reads only a literal leading printed number: %s", (sourceText, stem, expected) => expect(printedNumber(question({sourceText,stem}))).toBe(expected));
it.each(["01","٠١","۰۱","߀߁","०१","০১","੦੧","૦૧","୦୧","௦௧","౦౧","೦೧","൦൧","෦෧","๐๑","໐໑","༠༡","၀၁","႐႑","០១","᠐᠑","᥆᥇","᧐᧑","᪀᪁","᪐᪑","᭐᭑","᮰᮱","᱀᱁","᱐᱑","꘠꘡","꣐꣑","꤀꤁","꧐꧑","꧰꧱","꩐꩑","꯰꯱","０１","𐒠𐒡","𐴰𐴱","𐵀𐵁","𑁦𑁧","𑃰𑃱","𑄶𑄷","𑇐𑇑","𑋰𑋱","𑑐𑑑","𑓐𑓑","𑙐𑙑","𑛀𑛁","𑛐𑛑","𑛚𑛛","𑜰𑜱","𑣠𑣡","𑥐𑥑","𑯰𑯱","𑱐𑱑","𑵐𑵑","𑶠𑶡","𑽐𑽑","𖄰𖄱","𖩠𖩡","𖫀𖫁","𖭐𖭑","𖵰𖵱","𜳰𜳱","𝟎𝟏","𝟘𝟙","𝟢𝟣","𝟬𝟭","𝟶𝟷","𞅀𞅁","𞋰𞋱","𞓰𞓱","𞗱𞗲","𞥐𞥑","🯰🯱"]) ("retains decimal digit families without JavaScript numeric coercion: %s", digits => expect(printedNumber(question({ sourceText: `第 ${digits} 题：Question` }))).toBe("1"));
it.each([
  {"mode":"choice","text":"A、b;C","blankCount":null,"expected":{"correct":["A","b","C"]}},
  {"mode":"choice","text":"AB","blankCount":null,"expected":{"correct":["AB"]}},
  {"mode":"choice","text":"A-B","blankCount":null,"expected":{"correct":["A-B"]}},
  {"mode":"choice","text":"AB","blankCount":null,"expected":{"correct":["A","B"]}},
  {"mode":"choice","text":"A﻿B","blankCount":null,"expected":{"correct":["A﻿B"]}},
  {"mode":"true_false","text":"False","blankCount":null,"expected":{"value":false}},
  {"mode":"true_false","text":"TRUE","blankCount":null,"expected":{"value":true}},
  {"mode":"true_false","text":"错误","blankCount":null,"expected":{"value":false}},
  {"mode":"true_false","text":"正确","blankCount":null,"expected":{"value":true}},
  {"mode":"true_false","text":"对","blankCount":null,"expected":{"value":true}},
  {"mode":"true_false","text":"错","blankCount":null,"expected":{"value":false}},
  {"mode":"true_false","text":"√","blankCount":null,"expected":{"value":true}},
  {"mode":"true_false","text":"×","blankCount":null,"expected":{"value":false}},
  {"mode":"true_false","text":"是","blankCount":null,"expected":{"text":"是"}},
  {"mode":"true_false","text":"✓","blankCount":null,"expected":{"text":"✓"}},
  {"mode":"true_false","text":"unclear","blankCount":null,"expected":{"text":"unclear"}},
  {"mode":"fill_blank","text":"source phrase","blankCount":1,"expected":{"answers":["source phrase"]}},
  {"mode":"fill_blank","text":"a\nb","blankCount":1,"expected":{"answers":["a\nb"]}},
  {"mode":"fill_blank","text":"two blanks","blankCount":2,"expected":{"text":"two blanks"}},
  {"mode":"ordering","text":"1, 0","blankCount":null,"expected":{"order":[1,0]}},
  {"mode":"ordering","text":"１、０","blankCount":null,"expected":{"order":[1,0]}},
  {"mode":"ordering","text":"1.0,2","blankCount":null,"expected":{"text":"1.0,2"}},
  {"mode":"ordering","text":"1,","blankCount":null,"expected":{"text":"1,"}},
  {"mode":"matching","text":"0=1;1=0","blankCount":null,"expected":{"matches":[{"left":0,"right":1},{"left":1,"right":0}]}},
  {"mode":"matching","text":"１ = ０\n０=１","blankCount":null,"expected":{"matches":[{"left":1,"right":0},{"left":0,"right":1}]}},
  {"mode":"matching","text":"0=1.5","blankCount":null,"expected":{"text":"0=1.5"}},
  {"mode":"matching","text":"0=1;","blankCount":null,"expected":{"text":"0=1;"}},
  {"mode":"matching","text":"0=1\r\n1=0","blankCount":null,"expected":{"matches":[{"left":0,"right":1},{"left":1,"right":0}]}},
  {"mode":"short_answer","text":"Literal answer","blankCount":null,"expected":{"text":"Literal answer"}}
])("converts supplied literal $mode text: $text", ({mode,text,blankCount,expected}) => {
  const target = question({answerMode:mode,blankCount}), supplied = question({answerPayload:{text},analysis:"Supplied explanation"}), before=structuredClone({target,supplied});
  expect(associatedQuestion(target,supplied)).toMatchObject({answerPayload:expected,analysis:"Supplied explanation",needsReview:true,sourceText:target.sourceText}); expect({target,supplied}).toEqual(before);
});
it("keeps original answers, ambiguous candidates and question order visible", () => {
  const targets = [question({stem:"1. First"}), question({stem:"2. Existing",answerMode:"true_false",answerPayload:{value:false}}), question({stem:"3. Ambiguous"}),question({stem:"Unnumbered"}),question({stem:"1. Repeated"}),question({stem:"Parent",answerMode:"reading"})], answers=[question({stem:"1. Answer",answerPayload:{text:"A"}}),question({stem:"3. Answer",answerPayload:{text:"B"}}),question({stem:"3. Other",answerPayload:{text:"C"}})];
  const before=structuredClone({targets,answers}); expect(matchAnswers(document(targets),document(answers))).toEqual([{questionIndex:0,candidates:[0],status:"ambiguous"},{questionIndex:1,candidates:[],status:"has_answer"},{questionIndex:2,candidates:[1,2],status:"ambiguous"},{questionIndex:3,candidates:[],status:"unmatched"},{questionIndex:4,candidates:[0],status:"ambiguous"}]); expect({targets,answers}).toEqual(before);
  expect(matchAnswers(document([targets[0]]),document([answers[0]]))[0].status).toBe("unique");
});
it("requires a supplied answer and rejects unsafe ordering/matching IDs without rounding",()=>{
  expect(()=>associatedQuestion(question(),question())).toThrow(expect.objectContaining({code:"ANSWER_MATCH_INVALID"}));
  for(const [mode,text] of [["ordering","9007199254740993"],["matching","9007199254740993=0"]]) expect(()=>associatedQuestion(question({answerMode:mode}),question({answerPayload:{text}}))).toThrow(expect.objectContaining({code:"ANSWER_MATCH_INVALID"}));
});
it("preserves target analysis and rubric during an explicit association",()=>{
  const target=question({analysis:"Original analysis",scoringRubric:"Original rubric"}), supplied=question({answerPayload:{text:"Supplied"},analysis:"Other",scoringRubric:"Other"});
  expect(associatedQuestion(target,supplied)).toMatchObject({analysis:"Original analysis",scoringRubric:"Original rubric"});
});
