package main

import "testing"

func TestDispatchTargetRecognizesDBCommands(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "apply",
			args: []string{"db", "apply"},
			want: "db apply",
		},
		{
			name: "seed",
			args: []string{"db", "seed"},
			want: "db seed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := dispatchTarget(tt.args)
			if err != nil {
				t.Fatalf("dispatchTarget(%v) returned error: %v", tt.args, err)
			}
			if got != tt.want {
				t.Fatalf("dispatchTarget(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestRunExecutesDispatchedTarget(t *testing.T) {
	var (
		gotTarget string
		gotRoot   string
	)

	err := run([]string{"db", "apply"}, "/repo/root", func(_ string, target string) error {
		gotRoot = "/repo/root"
		gotTarget = target
		return nil
	})
	if err != nil {
		t.Fatalf("run returned error: %v", err)
	}
	if gotRoot != "/repo/root" {
		t.Fatalf("root = %q, want %q", gotRoot, "/repo/root")
	}
	if gotTarget != "db apply" {
		t.Fatalf("target = %q, want %q", gotTarget, "db apply")
	}
}
