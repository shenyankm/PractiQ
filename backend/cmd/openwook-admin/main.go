package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"openwook/internal/config"
	"openwook/internal/db"
)

func main() {
	if _, err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	if err := run(os.Args[1:], root, func(root string, target string) error {
		return db.Execute(context.Background(), target, root, os.Stdout)
	}); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func run(args []string, root string, execute func(string, string) error) error {
	target, err := dispatchTarget(args)
	if err != nil {
		return err
	}
	return execute(root, target)
}

func dispatchTarget(args []string) (string, error) {
	if len(args) >= 2 && args[0] == "db" {
		subcommand := strings.TrimSpace(args[1])
		switch subcommand {
		case "apply", "seed":
			return "db " + subcommand, nil
		}
	}
	return "", fmt.Errorf("unsupported command")
}
