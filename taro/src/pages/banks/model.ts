import type { Bank, BankScope, Pagination } from "../../api/contracts";

export type BankPhase = "idle" | "loading" | "refreshing" | "ready" | "loadingMore" | "error";
export type BankRequestMode = "replace" | "append";

export interface BankListState {
  scope: BankScope;
  phase: BankPhase;
  items: Bank[];
  cursor: string;
  hasMore: boolean;
  error: string | null;
  requestId: number;
}

export type BankListAction =
  | {
      type: "begin";
      scope: BankScope;
      mode: BankRequestMode;
      requestId: number;
    }
  | {
      type: "success";
      scope: BankScope;
      mode: BankRequestMode;
      requestId: number;
      items: Bank[];
      pagination: Pagination;
    }
  | {
      type: "failure";
      scope: BankScope;
      requestId: number;
      message: string;
    };

export const initialBankState: BankListState = {
  scope: "mine",
  phase: "idle",
  items: [],
  cursor: "",
  hasMore: true,
  error: null,
  requestId: 0,
};

export function reduceBankList(state: BankListState, action: BankListAction): BankListState {
  if (action.type === "begin") {
    const switching = action.scope !== state.scope;
    return {
      ...state,
      scope: action.scope,
      phase:
        action.mode === "append"
          ? "loadingMore"
          : state.items.length > 0 && !switching
            ? "refreshing"
            : "loading",
      items: switching ? [] : state.items,
      cursor: switching ? "" : state.cursor,
      hasMore: switching ? true : state.hasMore,
      error: null,
      requestId: action.requestId,
    };
  }

  if (action.requestId !== state.requestId || action.scope !== state.scope) {
    return state;
  }

  if (action.type === "failure") {
    return {
      ...state,
      phase: state.items.length > 0 ? "ready" : "error",
      error: action.message,
    };
  }

  const items = action.mode === "append" ? mergeBanks(state.items, action.items) : action.items;
  return {
    ...state,
    phase: "ready",
    items,
    cursor: action.pagination.cursor,
    hasMore: action.pagination.hasMore,
    error: null,
  };
}

function mergeBanks(current: Bank[], next: Bank[]): Bank[] {
  const seen = new Set(current.map((bank) => bank.id));
  return current.concat(next.filter((bank) => !seen.has(bank.id)));
}
