package billing

import (
	"os"
	"testing"
	"time"
)

func TestLoadConfigUsesCurrentCatalogDefaults(t *testing.T) {
	resetBillingEnv(t)

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}

	if cfg.Configured {
		t.Fatal("Configured = true, want false when Paddle secrets and price ids are unset")
	}
	if got := cfg.Environment; got != "sandbox" {
		t.Fatalf("Environment = %q, want %q", got, "sandbox")
	}
	if got := len(cfg.Plans); got != 2 {
		t.Fatalf("len(Plans) = %d, want 2", got)
	}

	plus := cfg.Plans[0]
	if got := plus.PlanKey; got != "plus" {
		t.Fatalf("plus.PlanKey = %q, want %q", got, "plus")
	}
	if got := plus.Label; got != "Plus" {
		t.Fatalf("plus.Label = %q, want %q", got, "Plus")
	}
	if got := plus.PriceID; got != "" {
		t.Fatalf("plus.PriceID = %q, want empty when unset", got)
	}
	if got := plus.AmountCents; got != 1900 {
		t.Fatalf("plus.AmountCents = %d, want %d", got, 1900)
	}
	if got := plus.CurrencyCode; got != "USD" {
		t.Fatalf("plus.CurrencyCode = %q, want %q", got, "USD")
	}
	if got := plus.Interval; got != "month" {
		t.Fatalf("plus.Interval = %q, want %q", got, "month")
	}
	if plus.TrialDays == nil || *plus.TrialDays != 7 {
		t.Fatalf("plus.TrialDays = %#v, want 7", plus.TrialDays)
	}

	enterprise := cfg.Plans[1]
	if got := enterprise.PlanKey; got != "enterprise" {
		t.Fatalf("enterprise.PlanKey = %q, want %q", got, "enterprise")
	}
	if got := enterprise.Label; got != "Enterprise" {
		t.Fatalf("enterprise.Label = %q, want %q", got, "Enterprise")
	}
	if got := enterprise.PriceID; got != "" {
		t.Fatalf("enterprise.PriceID = %q, want empty when unset", got)
	}
	if got := enterprise.AmountCents; got != 9900 {
		t.Fatalf("enterprise.AmountCents = %d, want %d", got, 9900)
	}
	if got := enterprise.CurrencyCode; got != "USD" {
		t.Fatalf("enterprise.CurrencyCode = %q, want %q", got, "USD")
	}
	if got := enterprise.Interval; got != "year" {
		t.Fatalf("enterprise.Interval = %q, want %q", got, "year")
	}
	if enterprise.TrialDays == nil || *enterprise.TrialDays != 14 {
		t.Fatalf("enterprise.TrialDays = %#v, want 14", enterprise.TrialDays)
	}
}

func TestLoadConfigUsesEnvValuesAndConfiguredFlagRequiresSecretsAndPriceIDs(t *testing.T) {
	resetBillingEnv(t)
	t.Setenv("PADDLE_ENVIRONMENT", "production")
	t.Setenv("PADDLE_API_KEY", "pdl_live_key")
	t.Setenv("PADDLE_CLIENT_TOKEN", "live_client_token")
	t.Setenv("PADDLE_WEBHOOK_SECRET", "pdl_ntf_secret")
	t.Setenv("PADDLE_PLUS_PRICE_ID", "pri_plus")
	t.Setenv("PADDLE_PLUS_LABEL", "Plus Annual")
	t.Setenv("PADDLE_PLUS_AMOUNT_CENTS", "2900")
	t.Setenv("PADDLE_PLUS_CURRENCY_CODE", "eur")
	t.Setenv("PADDLE_PLUS_INTERVAL", "year")
	t.Setenv("PADDLE_PLUS_TRIAL_DAYS", "21")
	t.Setenv("PADDLE_ENTERPRISE_PRICE_ID", "")
	t.Setenv("PADDLE_ENTERPRISE_LABEL", "Enterprise Team")
	t.Setenv("PADDLE_ENTERPRISE_AMOUNT_CENTS", "12900")
	t.Setenv("PADDLE_ENTERPRISE_CURRENCY_CODE", "gbp")
	t.Setenv("PADDLE_ENTERPRISE_INTERVAL", "month")
	t.Setenv("PADDLE_ENTERPRISE_TRIAL_DAYS", "30")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	if cfg.Configured {
		t.Fatal("Configured = true, want false when any paid plan is missing a Paddle price id")
	}
	if got := cfg.Environment; got != "production" {
		t.Fatalf("Environment = %q, want %q", got, "production")
	}

	plus := cfg.Plans[0]
	if got := plus.Label; got != "Plus Annual" {
		t.Fatalf("plus.Label = %q, want %q", got, "Plus Annual")
	}
	if got := plus.PriceID; got != "pri_plus" {
		t.Fatalf("plus.PriceID = %q, want %q", got, "pri_plus")
	}
	if got := plus.AmountCents; got != 2900 {
		t.Fatalf("plus.AmountCents = %d, want %d", got, 2900)
	}
	if got := plus.CurrencyCode; got != "EUR" {
		t.Fatalf("plus.CurrencyCode = %q, want %q", got, "EUR")
	}
	if got := plus.Interval; got != "year" {
		t.Fatalf("plus.Interval = %q, want %q", got, "year")
	}
	if plus.TrialDays == nil || *plus.TrialDays != 21 {
		t.Fatalf("plus.TrialDays = %#v, want 21", plus.TrialDays)
	}

	enterprise := cfg.Plans[1]
	if got := enterprise.Label; got != "Enterprise Team" {
		t.Fatalf("enterprise.Label = %q, want %q", got, "Enterprise Team")
	}
	if got := enterprise.PriceID; got != "" {
		t.Fatalf("enterprise.PriceID = %q, want empty before env is configured", got)
	}
	if got := enterprise.AmountCents; got != 12900 {
		t.Fatalf("enterprise.AmountCents = %d, want %d", got, 12900)
	}
	if got := enterprise.CurrencyCode; got != "GBP" {
		t.Fatalf("enterprise.CurrencyCode = %q, want %q", got, "GBP")
	}
	if got := enterprise.Interval; got != "month" {
		t.Fatalf("enterprise.Interval = %q, want %q", got, "month")
	}
	if enterprise.TrialDays == nil || *enterprise.TrialDays != 30 {
		t.Fatalf("enterprise.TrialDays = %#v, want 30", enterprise.TrialDays)
	}

	t.Setenv("PADDLE_ENTERPRISE_PRICE_ID", "pri_enterprise")
	cfg, err = LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error after full env setup: %v", err)
	}
	if !cfg.Configured {
		t.Fatal("Configured = false, want true when Paddle secrets and both paid price ids are present")
	}
	if got := cfg.Plans[1].PriceID; got != "pri_enterprise" {
		t.Fatalf("enterprise.PriceID = %q, want %q", got, "pri_enterprise")
	}
}

func TestPlanKeyForPriceIDUsesConfiguredCatalog(t *testing.T) {
	resetBillingEnv(t)
	t.Setenv("PADDLE_PLUS_PRICE_ID", "pri_plus")
	t.Setenv("PADDLE_ENTERPRISE_PRICE_ID", "pri_enterprise")

	if got, ok := PlanKeyForPriceID("pri_plus"); !ok || got != "plus" {
		t.Fatalf("PlanKeyForPriceID(pri_plus) = (%q, %t), want (%q, true)", got, ok, "plus")
	}
	if got, ok := PlanKeyForPriceID("pri_enterprise"); !ok || got != "enterprise" {
		t.Fatalf("PlanKeyForPriceID(pri_enterprise) = (%q, %t), want (%q, true)", got, ok, "enterprise")
	}
	if got, ok := PlanKeyForPriceID(""); ok || got != "" {
		t.Fatalf("PlanKeyForPriceID(empty) = (%q, %t), want (empty, false)", got, ok)
	}
	if got, ok := PlanKeyForPriceID("pri_unknown"); ok || got != "" {
		t.Fatalf("PlanKeyForPriceID(pri_unknown) = (%q, %t), want (empty, false)", got, ok)
	}
}

func TestNormalizeSubscriptionMapsFreeFallbackAndSyncedPaddleState(t *testing.T) {
	free := NormalizeSubscription("free", nil)
	if got := free.Membership; got != "free" {
		t.Fatalf("free.Membership = %q, want %q", got, "free")
	}
	if got := free.Status; got != "inactive" {
		t.Fatalf("free.Status = %q, want %q", got, "inactive")
	}
	if got := free.Source; got != "free" {
		t.Fatalf("free.Source = %q, want %q", got, "free")
	}
	if free.CurrentPeriodEndsAt != nil {
		t.Fatalf("free.CurrentPeriodEndsAt = %#v, want nil", free.CurrentPeriodEndsAt)
	}
	if free.PaddleSubscriptionID != nil || free.PaddleTransactionID != nil || free.PaddlePriceID != nil {
		t.Fatalf("free paddle ids = %#v / %#v / %#v, want nils", free.PaddleSubscriptionID, free.PaddleTransactionID, free.PaddlePriceID)
	}

	endsAt := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	paid := NormalizeSubscription("free", &SubscriptionRow{
		Membership:           "enterprise",
		Status:               "active",
		Source:               "paddle",
		PaddleSubscriptionID: new("sub_123"),
		PaddleTransactionID:  new("txn_123"),
		PaddlePriceID:        new("pri_enterprise"),
		CurrentPeriodEndsAt:  new(endsAt),
	})
	if got := paid.Membership; got != "enterprise" {
		t.Fatalf("paid.Membership = %q, want %q", got, "enterprise")
	}
	if got := paid.Status; got != "active" {
		t.Fatalf("paid.Status = %q, want %q", got, "active")
	}
	if got := paid.Source; got != "paddle" {
		t.Fatalf("paid.Source = %q, want %q", got, "paddle")
	}
	if paid.CurrentPeriodEndsAt == nil || *paid.CurrentPeriodEndsAt != formatRFC3339Millis(endsAt) {
		t.Fatalf("paid.CurrentPeriodEndsAt = %#v, want %q", paid.CurrentPeriodEndsAt, formatRFC3339Millis(endsAt))
	}
	if paid.PaddleSubscriptionID == nil || *paid.PaddleSubscriptionID != "sub_123" {
		t.Fatalf("paid.PaddleSubscriptionID = %#v, want sub_123", paid.PaddleSubscriptionID)
	}
	if paid.PaddleTransactionID == nil || *paid.PaddleTransactionID != "txn_123" {
		t.Fatalf("paid.PaddleTransactionID = %#v, want txn_123", paid.PaddleTransactionID)
	}
	if paid.PaddlePriceID == nil || *paid.PaddlePriceID != "pri_enterprise" {
		t.Fatalf("paid.PaddlePriceID = %#v, want pri_enterprise", paid.PaddlePriceID)
	}
}

func TestPaidAccessHelpersMirrorCurrentBillingStateRules(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	future := now.Add(48 * time.Hour)
	past := now.Add(-48 * time.Hour)

	tests := []struct {
		name           string
		status         string
		currentPeriod  *time.Time
		wantAccess     bool
		wantMembership string
	}{
		{name: "active keeps access", status: "active", wantAccess: true, wantMembership: "enterprise"},
		{name: "trialing keeps access", status: "trialing", wantAccess: true, wantMembership: "enterprise"},
		{name: "past due keeps access", status: "past_due", wantAccess: true, wantMembership: "enterprise"},
		{name: "canceled keeps access until current period ends", status: "canceled", currentPeriod: &future, wantAccess: true, wantMembership: "enterprise"},
		{name: "inactive loses access after expiry", status: "inactive", currentPeriod: &past, wantAccess: false, wantMembership: "free"},
		{name: "canceled without active period loses access", status: "canceled", currentPeriod: nil, wantAccess: false, wantMembership: "free"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := keepsPaidAccess(tt.status, tt.currentPeriod, now); got != tt.wantAccess {
				t.Fatalf("keepsPaidAccess(%q, %#v, now) = %t, want %t", tt.status, tt.currentPeriod, got, tt.wantAccess)
			}
			if got := userMembershipFromState("enterprise", tt.status, tt.currentPeriod, now); got != tt.wantMembership {
				t.Fatalf("userMembershipFromState(...) = %q, want %q", got, tt.wantMembership)
			}
		})
	}
}

func TestSubscriptionPayloadFromEventNormalizesSubscriptionWebhookData(t *testing.T) {
	resetBillingEnv(t)
	t.Setenv("PADDLE_ENTERPRISE_PRICE_ID", "pri_enterprise")

	payload, err := subscriptionPayloadFromEvent(map[string]any{
		"id":            "sub_123",
		"customerId":    "ctm_123",
		"transactionId": "txn_123",
		"status":        "active",
		"items":         []any{map[string]any{"priceId": "pri_enterprise", "quantity": 1}},
		"currentBillingPeriod": map[string]any{
			"startsAt": "2026-01-01T00:00:00.000Z",
			"endsAt":   "2027-01-01T00:00:00.000Z",
		},
		"scheduledChanges": []any{map[string]any{
			"action":      "cancel",
			"effectiveAt": "2027-01-01T00:00:00.000Z",
		}},
		"customData": map[string]any{
			"userId":  int64(7),
			"planKey": "enterprise",
		},
	}, 0)
	if err != nil {
		t.Fatalf("subscriptionPayloadFromEvent returned error: %v", err)
	}
	if payload == nil {
		t.Fatal("subscriptionPayloadFromEvent returned nil payload, want normalized value")
	}
	if got := payload.UserID; got != 7 {
		t.Fatalf("payload.UserID = %d, want %d", got, 7)
	}
	if got := payload.Membership; got != "enterprise" {
		t.Fatalf("payload.Membership = %q, want %q", got, "enterprise")
	}
	if got := payload.Status; got != "active" {
		t.Fatalf("payload.Status = %q, want %q", got, "active")
	}
	if payload.CustomerID == nil || *payload.CustomerID != "ctm_123" {
		t.Fatalf("payload.CustomerID = %#v, want ctm_123", payload.CustomerID)
	}
	if payload.SubscriptionID == nil || *payload.SubscriptionID != "sub_123" {
		t.Fatalf("payload.SubscriptionID = %#v, want sub_123", payload.SubscriptionID)
	}
	if payload.TransactionID == nil || *payload.TransactionID != "txn_123" {
		t.Fatalf("payload.TransactionID = %#v, want txn_123", payload.TransactionID)
	}
	if payload.PriceID == nil || *payload.PriceID != "pri_enterprise" {
		t.Fatalf("payload.PriceID = %#v, want pri_enterprise", payload.PriceID)
	}
	if payload.CurrentPeriodStartsAt == nil || *payload.CurrentPeriodStartsAt != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("payload.CurrentPeriodStartsAt = %#v, want 2026-01-01T00:00:00.000Z", payload.CurrentPeriodStartsAt)
	}
	if payload.CurrentPeriodEndsAt == nil || *payload.CurrentPeriodEndsAt != "2027-01-01T00:00:00.000Z" {
		t.Fatalf("payload.CurrentPeriodEndsAt = %#v, want 2027-01-01T00:00:00.000Z", payload.CurrentPeriodEndsAt)
	}
	if payload.ScheduledChangeAction == nil || *payload.ScheduledChangeAction != "cancel" {
		t.Fatalf("payload.ScheduledChangeAction = %#v, want cancel", payload.ScheduledChangeAction)
	}
	if payload.ScheduledChangeEffectiveAt == nil || *payload.ScheduledChangeEffectiveAt != "2027-01-01T00:00:00.000Z" {
		t.Fatalf("payload.ScheduledChangeEffectiveAt = %#v, want 2027-01-01T00:00:00.000Z", payload.ScheduledChangeEffectiveAt)
	}
}

func TestTransactionPayloadFromEventFallsBackToProvidedUserIDAndCustomPlanKey(t *testing.T) {
	resetBillingEnv(t)
	t.Setenv("PADDLE_PLUS_PRICE_ID", "pri_plus")

	payload, err := transactionPayloadFromEvent(map[string]any{
		"id":             "txn_987",
		"subscriptionId": "sub_987",
		"customerId":     "ctm_987",
		"items":          []any{map[string]any{"priceId": "pri_unknown", "quantity": 1}},
		"customData": map[string]any{
			"planKey": "plus",
		},
	}, 42)
	if err != nil {
		t.Fatalf("transactionPayloadFromEvent returned error: %v", err)
	}
	if payload == nil {
		t.Fatal("transactionPayloadFromEvent returned nil payload, want normalized value")
	}
	if got := payload.UserID; got != 42 {
		t.Fatalf("payload.UserID = %d, want %d", got, 42)
	}
	if got := payload.Membership; got != "plus" {
		t.Fatalf("payload.Membership = %q, want %q", got, "plus")
	}
	if payload.CustomerID == nil || *payload.CustomerID != "ctm_987" {
		t.Fatalf("payload.CustomerID = %#v, want ctm_987", payload.CustomerID)
	}
	if got := payload.TransactionID; got != "txn_987" {
		t.Fatalf("payload.TransactionID = %q, want %q", got, "txn_987")
	}
	if payload.PriceID == nil || *payload.PriceID != "pri_unknown" {
		t.Fatalf("payload.PriceID = %#v, want pri_unknown", payload.PriceID)
	}
}

func formatRFC3339Millis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func resetBillingEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PADDLE_API_KEY",
		"PADDLE_CLIENT_TOKEN",
		"PADDLE_ENTERPRISE_AMOUNT_CENTS",
		"PADDLE_ENTERPRISE_CURRENCY_CODE",
		"PADDLE_ENTERPRISE_INTERVAL",
		"PADDLE_ENTERPRISE_LABEL",
		"PADDLE_ENTERPRISE_PRICE_ID",
		"PADDLE_ENTERPRISE_TRIAL_DAYS",
		"PADDLE_ENVIRONMENT",
		"PADDLE_PLUS_AMOUNT_CENTS",
		"PADDLE_PLUS_CURRENCY_CODE",
		"PADDLE_PLUS_INTERVAL",
		"PADDLE_PLUS_LABEL",
		"PADDLE_PLUS_PRICE_ID",
		"PADDLE_PLUS_TRIAL_DAYS",
		"PADDLE_WEBHOOK_SECRET",
	} {
		unsetEnv(t, key)
	}
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	value, ok := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("Unsetenv(%s) returned error: %v", key, err)
	}
	t.Cleanup(func() {
		if !ok {
			_ = os.Unsetenv(key)
			return
		}
		_ = os.Setenv(key, value)
	})
}
