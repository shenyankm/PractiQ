import { expect, it } from "vitest";
import { allocate, cents, sample, split } from "./paper";
import type { QuestionRow } from "./api";
const rows=[{id:"a",question:{answerMode:"choice",choiceVariant:"single"}},{id:"b",question:{answerMode:"choice",choiceVariant:"single"}},{id:"c",question:{answerMode:"short_answer"}}] as QuestionRow[];
it("allocates exact hundredths with stable remainders and type budgets",()=>{
  expect(cents("0.29")).toBe(29);expect(split(10000,3)).toEqual([3334,3333,3333]);
  expect(allocate(rows,10000,{single:3333,short_answer:6667})).toEqual([1667,1666,6667]);
  expect(()=>cents("1.001")).toThrow();expect(()=>split(2,3)).toThrow();expect(()=>allocate(rows,10000,{single:5000,short_answer:1})).toThrow();
});
it("samples without replacement and refuses shortages",()=>{expect(new Set(sample(rows,3,true).map(q=>q.id)).size).toBe(3);expect(()=>sample(rows,4,false)).toThrow();expect(sample(rows,2,false).map(q=>q.id)).toEqual(["a","b"]);});
