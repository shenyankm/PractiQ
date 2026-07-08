package billing

import (
	"fmt"
	"os"
	"strings"
	"time"
)

type Plan struct {
	PlanKey      string
	Label        string
	PriceID      string
	AmountCents  int
	CurrencyCode string
	Interval     string
	TrialDays    *int
}

type Config struct {
	Configured  bool
	Environment string
	Plans       []Plan
}

type Subscription struct {
	Membership           string
	Status               string
	Source               string
	CurrentPeriodEndsAt  *string
	PaddleSubscriptionID *string
	PaddleTransactionID  *string
	PaddlePriceID        *string
}

type SubscriptionRow struct {
	Membership           string
	Status               string
	Source               string
	PaddleSubscriptionID *string
	PaddleTransactionID  *string
	PaddlePriceID        *string
	CurrentPeriodEndsAt  *time.Time
}

type SubscriptionPayload struct {
	UserID                     int
	Membership                 string
	Status                     string
	CustomerID                 *string
	SubscriptionID             *string
	TransactionID              *string
	PriceID                    *string
	CurrentPeriodStartsAt      *string
	CurrentPeriodEndsAt        *string
	ScheduledChangeAction      *string
	ScheduledChangeEffectiveAt *string
}

type TransactionPayload struct {
	UserID        int
	Membership    string
	CustomerID    *string
	TransactionID string
	PriceID       *string
}

func LoadConfig() (Config, error) {
	plans := []Plan{
		buildPlan("plus", "Plus", 1900, "USD", "month", 7),
		buildPlan("enterprise", "Enterprise", 9900, "USD", "year", 14),
	}
	cfg := Config{
		Environment: parseEnvironment(os.Getenv("PADDLE_ENVIRONMENT")),
		Plans:       plans,
	}
	cfg.Configured = strings.TrimSpace(os.Getenv("PADDLE_API_KEY")) != "" &&
		strings.TrimSpace(os.Getenv("PADDLE_CLIENT_TOKEN")) != "" &&
		strings.TrimSpace(os.Getenv("PADDLE_WEBHOOK_SECRET")) != "" &&
		plans[0].PriceID != "" &&
		plans[1].PriceID != ""
	return cfg, nil
}

func PlanKeyForPriceID(priceID string) (string, bool) {
	if strings.TrimSpace(priceID) == "" {
		return "", false
	}
	cfg, _ := LoadConfig()
	for _, plan := range cfg.Plans {
		if plan.PriceID == priceID {
			return plan.PlanKey, true
		}
	}
	return "", false
}

func NormalizeSubscription(userMembership string, row *SubscriptionRow) Subscription {
	if row == nil {
		status := "inactive"
		source := "free"
		if userMembership != "free" {
			status = "active"
			source = "paddle"
		}
		return Subscription{Membership: userMembership, Status: status, Source: source}
	}
	var endsAt *string
	if row.CurrentPeriodEndsAt != nil {
		formatted := formatBillingMillis(*row.CurrentPeriodEndsAt)
		endsAt = &formatted
	}
	return Subscription{
		Membership:           row.Membership,
		Status:               row.Status,
		Source:               row.Source,
		CurrentPeriodEndsAt:  endsAt,
		PaddleSubscriptionID: row.PaddleSubscriptionID,
		PaddleTransactionID:  row.PaddleTransactionID,
		PaddlePriceID:        row.PaddlePriceID,
	}
}

func keepsPaidAccess(status string, currentPeriod *time.Time, now time.Time) bool {
	switch status {
	case "active", "trialing", "past_due":
		return true
	}
	return currentPeriod != nil && currentPeriod.After(now)
}

func userMembershipFromState(membership string, status string, currentPeriod *time.Time, now time.Time) string {
	if keepsPaidAccess(status, currentPeriod, now) {
		return membership
	}
	return "free"
}

func subscriptionPayloadFromEvent(event map[string]any, fallbackUserID int) (*SubscriptionPayload, error) {
	customData := mapValue(event, "customData")
	priceID := firstItemPriceID(event)
	membership, _ := PlanKeyForPriceID(derefString(priceID))
	if membership == "" {
		membership = stringValue(customData, "planKey")
	}
	userID := intValue(customData, "userId")
	if userID == 0 {
		userID = fallbackUserID
	}
	if userID == 0 || membership == "" {
		return nil, fmt.Errorf("subscription event missing user or membership")
	}
	period := mapValue(event, "currentBillingPeriod")
	change := firstListItem(mapValueSlice(event, "scheduledChanges"))
	return &SubscriptionPayload{
		UserID:                     userID,
		Membership:                 membership,
		Status:                     stringValue(event, "status"),
		CustomerID:                 stringPtrValue(event, "customerId"),
		SubscriptionID:             stringPtrValue(event, "id"),
		TransactionID:              stringPtrValue(event, "transactionId"),
		PriceID:                    priceID,
		CurrentPeriodStartsAt:      stringPtrValue(period, "startsAt"),
		CurrentPeriodEndsAt:        stringPtrValue(period, "endsAt"),
		ScheduledChangeAction:      stringPtrValue(change, "action"),
		ScheduledChangeEffectiveAt: stringPtrValue(change, "effectiveAt"),
	}, nil
}

func transactionPayloadFromEvent(event map[string]any, fallbackUserID int) (*TransactionPayload, error) {
	customData := mapValue(event, "customData")
	priceID := firstItemPriceID(event)
	membership, _ := PlanKeyForPriceID(derefString(priceID))
	if membership == "" {
		membership = stringValue(customData, "planKey")
	}
	userID := intValue(customData, "userId")
	if userID == 0 {
		userID = fallbackUserID
	}
	if userID == 0 || membership == "" {
		return nil, fmt.Errorf("transaction event missing user or membership")
	}
	id := stringValue(event, "id")
	if id == "" {
		return nil, fmt.Errorf("transaction event missing id")
	}
	return &TransactionPayload{
		UserID:        userID,
		Membership:    membership,
		CustomerID:    stringPtrValue(event, "customerId"),
		TransactionID: id,
		PriceID:       priceID,
	}, nil
}

func SubscriptionPayloadFromEvent(event map[string]any, fallbackUserID int) (*SubscriptionPayload, error) {
	return subscriptionPayloadFromEvent(event, fallbackUserID)
}

func TransactionPayloadFromEvent(event map[string]any, fallbackUserID int) (*TransactionPayload, error) {
	return transactionPayloadFromEvent(event, fallbackUserID)
}

func buildPlan(planKey, fallbackLabel string, amount int, currency, interval string, trialDays int) Plan {
	prefix := "PADDLE_" + strings.ToUpper(planKey)
	label := strings.TrimSpace(os.Getenv(prefix + "_LABEL"))
	if label == "" {
		label = fallbackLabel
	}
	priceID := strings.TrimSpace(os.Getenv(prefix + "_PRICE_ID"))
	amountCents := parseInt(os.Getenv(prefix+"_AMOUNT_CENTS"), amount)
	currencyCode := strings.ToUpper(strings.TrimSpace(os.Getenv(prefix + "_CURRENCY_CODE")))
	if currencyCode == "" {
		currencyCode = currency
	}
	resolvedInterval := strings.TrimSpace(os.Getenv(prefix + "_INTERVAL"))
	if resolvedInterval == "" {
		resolvedInterval = interval
	}
	trial := parseInt(os.Getenv(prefix+"_TRIAL_DAYS"), trialDays)
	return Plan{PlanKey: planKey, Label: label, PriceID: priceID, AmountCents: amountCents, CurrencyCode: currencyCode, Interval: resolvedInterval, TrialDays: new(trial)}
}

func parseEnvironment(value string) string {
	if strings.TrimSpace(value) == "production" {
		return "production"
	}
	return "sandbox"
}

func parseInt(raw string, fallback int) int {
	var value int
	if _, err := fmt.Sscanf(strings.TrimSpace(raw), "%d", &value); err != nil || value <= 0 {
		return fallback
	}
	return value
}

func formatBillingMillis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func mapValue(values map[string]any, key string) map[string]any {
	if values == nil {
		return nil
	}
	mapped, _ := values[key].(map[string]any)
	return mapped
}

func mapValueSlice(values map[string]any, key string) []map[string]any {
	items, _ := values[key].([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		mapped, _ := item.(map[string]any)
		if mapped != nil {
			out = append(out, mapped)
		}
	}
	return out
}

func firstListItem(values []map[string]any) map[string]any {
	if len(values) == 0 {
		return nil
	}
	return values[0]
}

func stringValue(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	s, _ := values[key].(string)
	return s
}

func stringPtrValue(values map[string]any, key string) *string {
	value := stringValue(values, key)
	if value == "" {
		return nil
	}
	return &value
}

func intValue(values map[string]any, key string) int {
	if values == nil {
		return 0
	}
	switch value := values[key].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func firstItemPriceID(event map[string]any) *string {
	items := mapValueSlice(event, "items")
	if len(items) == 0 {
		return nil
	}
	return stringPtrValue(items[0], "priceId")
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
