package httpserver

import (
	"context"
	"errors"
	"net/http"
	"testing"

	paddle "github.com/PaddleHQ/paddle-go-sdk/v5"
	paddleerr "github.com/PaddleHQ/paddle-go-sdk/v5/pkg/paddleerr"

	"openwook/internal/api"
	"openwook/internal/auth"
	"openwook/internal/billing"
)

type fakePaddleTransactionCreator struct {
	req         *paddle.CreateTransactionRequest
	transaction *paddle.Transaction
	err         error
}

func (f *fakePaddleTransactionCreator) CreateTransaction(_ context.Context, req *paddle.CreateTransactionRequest) (*paddle.Transaction, error) {
	f.req = req
	return f.transaction, f.err
}

func TestCreatePaddleTransactionWithClientUsesPaddleSDKRequest(t *testing.T) {
	customerID := "ctm_123"
	fake := &fakePaddleTransactionCreator{transaction: &paddle.Transaction{ID: "txn_123", CustomerID: &customerID}}
	plan := billing.Plan{PlanKey: "plus", PriceID: "pri_plus"}
	user := auth.User{ID: 7}

	transactionID, returnedCustomerID, rawPayload, err := createPaddleTransactionWithClient(context.Background(), fake, plan, user)
	if err != nil {
		t.Fatalf("createPaddleTransactionWithClient returned error: %v", err)
	}
	if transactionID != "txn_123" {
		t.Fatalf("transactionID = %q, want txn_123", transactionID)
	}
	if returnedCustomerID == nil || *returnedCustomerID != customerID {
		t.Fatalf("customerID = %#v, want %q", returnedCustomerID, customerID)
	}
	if got := rawPayload["id"]; got != "txn_123" {
		t.Fatalf("rawPayload[id] = %#v, want txn_123", got)
	}
	if got := rawPayload["customer_id"]; got != customerID {
		t.Fatalf("rawPayload[customer_id] = %#v, want %q", got, customerID)
	}
	if fake.req == nil {
		t.Fatal("CreateTransaction was not called")
	}
	if len(fake.req.Items) != 1 || fake.req.Items[0].TransactionItemFromCatalog == nil {
		t.Fatalf("Items = %#v, want one catalog item", fake.req.Items)
	}
	item := fake.req.Items[0].TransactionItemFromCatalog
	if item.PriceID != "pri_plus" || item.Quantity != 1 {
		t.Fatalf("catalog item = %#v, want pri_plus quantity 1", item)
	}
	if fake.req.CollectionMode == nil || *fake.req.CollectionMode != paddle.CollectionModeAutomatic {
		t.Fatalf("CollectionMode = %#v, want automatic", fake.req.CollectionMode)
	}
	if fake.req.CustomData["userId"] != user.ID || fake.req.CustomData["planKey"] != plan.PlanKey {
		t.Fatalf("CustomData = %#v, want user and plan metadata", fake.req.CustomData)
	}
}

func TestCreatePaddleTransactionWithClientMapsPaddleSDKError(t *testing.T) {
	fake := &fakePaddleTransactionCreator{err: &paddleerr.Error{
		Status: http.StatusBadRequest,
		Type:   paddleerr.ErrorTypeRequestError,
		Code:   "transaction_price_not_found",
		Detail: "Price not found",
	}}

	_, _, _, err := createPaddleTransactionWithClient(context.Background(), fake, billing.Plan{PlanKey: "plus", PriceID: "pri_missing"}, auth.User{ID: 7})
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %#v, want *api.Error", err)
	}
	if apiErr.Status != http.StatusBadGateway || apiErr.Code != "PADDLE_REQUEST_FAILED" {
		t.Fatalf("api error = (%d, %s), want (%d, PADDLE_REQUEST_FAILED)", apiErr.Status, apiErr.Code, http.StatusBadGateway)
	}
	details, ok := apiErr.Details.(map[string]any)
	if !ok {
		t.Fatalf("Details = %#v, want map", apiErr.Details)
	}
	if details["code"] != "transaction_price_not_found" || details["detail"] != "Price not found" {
		t.Fatalf("Details = %#v, want Paddle error details", details)
	}
}
