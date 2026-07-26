package main

import (
	"testing"

	"openwook/internal/aiclient"
)

func TestMapOptionsPreservesOrderAndCorrectness(t *testing.T) {
	mapped := mapOptions([]aiclient.ParsedOption{
		{Label: "A", Content: "4", IsCorrect: true},
		{Label: "B", Content: "5"},
	})

	if len(mapped) != 2 {
		t.Fatalf("len = %d, want 2", len(mapped))
	}
	if mapped[0].Label != "A" || mapped[0].Content != "4" || !mapped[0].IsCorrect {
		t.Fatalf("mapped[0] = %+v, want A/4/correct", mapped[0])
	}
	if mapped[1].Label != "B" || mapped[1].IsCorrect {
		t.Fatalf("mapped[1] = %+v, want B/incorrect", mapped[1])
	}
}

func TestMapContentBlocksAssignsSequentialSequenceAndNilsBlanks(t *testing.T) {
	mapped := mapContentBlocks([]aiclient.ContentBlock{
		{PartType: "text", Role: "stem", TextValue: "What is 2+2?"},
		{PartType: "formula", LatexValue: "x^2", TextValue: "  "},
	})

	if len(mapped) != 2 {
		t.Fatalf("len = %d, want 2", len(mapped))
	}
	for index, block := range mapped {
		if block.Sequence == nil || *block.Sequence != index+1 {
			t.Fatalf("mapped[%d].Sequence = %v, want %d", index, block.Sequence, index+1)
		}
	}
	if mapped[0].Role == nil || *mapped[0].Role != "stem" || mapped[0].TextValue == nil {
		t.Fatalf("mapped[0] = %+v, want stem role with text", mapped[0])
	}
	if mapped[1].TextValue != nil {
		t.Fatalf("mapped[1].TextValue = %v, want nil for blank value", *mapped[1].TextValue)
	}
	if mapped[1].LatexValue == nil || *mapped[1].LatexValue != "x^2" {
		t.Fatalf("mapped[1].LatexValue = %v, want x^2", mapped[1].LatexValue)
	}
}

func TestCountCorrectDrivesChoiceVariant(t *testing.T) {
	single := []aiclient.ParsedOption{{Label: "A", IsCorrect: true}, {Label: "B"}}
	multiple := []aiclient.ParsedOption{{Label: "A", IsCorrect: true}, {Label: "B", IsCorrect: true}}

	if got := countCorrect(single); got != 1 {
		t.Fatalf("countCorrect(single) = %d, want 1", got)
	}
	if got := countCorrect(multiple); got != 2 {
		t.Fatalf("countCorrect(multiple) = %d, want 2", got)
	}
	if got := countCorrect(nil); got != 0 {
		t.Fatalf("countCorrect(nil) = %d, want 0", got)
	}
}

func TestValueOrDefaultFallsBackOnNilAndBlank(t *testing.T) {
	blank := "  "
	value := "pdf"

	if got := valueOrDefault(nil, "txt"); got != "txt" {
		t.Fatalf("valueOrDefault(nil) = %q, want txt", got)
	}
	if got := valueOrDefault(&blank, "txt"); got != "txt" {
		t.Fatalf("valueOrDefault(blank) = %q, want txt", got)
	}
	if got := valueOrDefault(&value, "txt"); got != "pdf" {
		t.Fatalf("valueOrDefault(pdf) = %q, want pdf", got)
	}
}
