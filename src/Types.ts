import { HttpError } from "@wymp/http-errors";
import { Api } from "@wymp/types";

/** A simple type indicating an error */
export type ErrorResult = { status: "error"; error: HttpError };

/**
 * The result of a login attempt. This can be either "success", in which case the client can be
 * understood to be "authenticated"; "error", in which case there was an error logging in; "2fa",
 * indicating that the user should be prompted for a 2fa TOTP; or "email", indicating that the
 * user should check their email to complete login via email link.
 */
export type LoginResult =
  | { status: "success" }
  | { status: "email" }
  | { status: "2fa"; code: string }
  | ErrorResult;

/**
 * A `NextableResponse` is a packet of information that makes it easy to go back and forth through
 * paged results. This "freezes" the request parameters that were originally used to make the request
 * and uses them to make subsequent requests for next (and previous) pages.
 */
export type NextableResponse<T = unknown> = {
  endpoint: string;
  params?: Api.Client.CollectionParams;
  response: Api.CollectionResponse<T>;
};

/**
 * A simple definition for the `included` param of a response
 */
export type Included = undefined | Array<{ id: string; type: string }>;

/**
 * The minimum interface required for credential storage. The user is left to decide what actual
 * back end this uses, but it is assumed that it will be either `window.sessionStorage` or
 * `window.localStorage` on the browser, and perhaps a cache or database on the server side.
 */
export interface StorageApi {
  /** Get the item for the given key */
  getItem(key: string): string | null;

  /** Set the given value for the given key */
  setItem(key: string, val: string): void;

  /** Unset the value for the given key */
  removeItem(key: string): void;
}
