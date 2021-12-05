Luminous Money Typescript Client
============================================================================================

Luminous is a personal and shared financial tool for modern humans. Its focus is on simplicity in
planning your spending and saving, either as an individual or as a couple.

Other luminous codebases can be found at https://github.com/luminous-money/.


## Client

This is a typescript client for interacting with the Luminous Money APIs. It is a somewhat bare-bones
client and only seeks to provide some additional support around user management, error handling,
logging, and other such things to make development against the Luminous REST APIs more robust.


### Client API

*Note: The following sections describe some of the "why" of the client API. However, a full API
reference is provided further below.*


#### Errors

The client will always convert HTTP errors into javascript errors and throw them. It uses the
[@wymp/http-errors](https://github.com/wymp/ts-http-errors) library to offer errors with information
that goes beyond a simple "message". Luminous APIs use this same library on the back-end to offer


#### Session Management

Because session management can get complicated, much of the actual work that the client does is
that.

There is a specific method for logging in (`login`) and a specific one for logging out (`logout`).
These methods utilize storage (passed in on instantiation) to store credentials.

There is additionally a `loggedIn` method that allows you to easily determine if a user is logged in
or not. This method simply makes a call to the `GET /accounts/v1/users/current` endpoint to judge
whether the current session (if existing) is live. It returns `Promise<boolean>`.

Finally, since session tokens can expire somewhat frequently, the client makes the credential refresh
loop opaque, so you don't have to deal with it. That means that if you get a `401` error, the refresh
token has expired and you must go through the login flow again.


#### HTTP Verb Methods

To keep things simple, we've decided to implement the rest of the client using simple HTTP verb
methods instead of trying to build big object structures that have to be maintained as the API
evolves. That means you still have to know the endpoints, and you still have to deal with the raw
API output, which can involve not only "primary" data but included data and pagination as well.

Because this client is purpose-built for this specific API, it does provide some helper methods to
assist with some of these things. For example, it provides `next` and `prev` methods that you can
use to get the next and previous pages of results for a given result set. Additionally, it provides
a `findIncluded` method that helps find results within the `included` section of a result set.


#### Client API Reference

Without further ado, following is the full client API reference. (Note that many of these defintions
use types that are defined further below in the [Type Definitions](#type-definitions) section.)


##### Session Management

**`createUser(name: string, email: string, password: string, passwordConf: string): Promise<void>`** -
Creates a new user, returning an active session for the created user (assuming the creation is
successful).

**`login(email: string, password: string): Promise<LoginResult>`** - Takes the user's email and
password and attempts to obtain a session token with it.

**`totp(code: string, totp: string): Promise<LoginResult>`** - If the `login` method returned a
result with status `2fa`, then you should ask the user for a TOTP from their auth app and submit it
via this method. This method should return either success or error (not another 2fa).

**`logout(): Promise<void>`** - If the user is logged in, this submits a request to invalidate their
current credentials and returns true. If we don't have any credentials saved, it simply returns true.

**`loggedIn(): Promise<boolean>`** - If the user is logged or their credentials are expired, returns
false. If they are logged in with valid credentials, returns true.


##### Data Methods

**`get<T>(endpoint: string, params?: Api.Client.CollectionParams): Promise<Exclude<Api.Response<T>, Api.ErrorResponse>>`** - Get
data from the API for the given endpoint and with the given parameters.

**`post<T, I = T>(endpoint: string, data?: I): Promise<Api.SingleResponse<T>>`** - Create the
given object at the given endpoint.

**`patch<T, I = T>(endpoint: string, data: Partial<I>): Promise<Api.SingleResponse<T>>`** - Update the
given object.

**`delete(endpoint: string): Promise<Api.NullResponse>`** - Delete the given object. (Note that not all
objects are deletable.)

**`next<T>(endpoint: string, params?: Api.Client.CollectionParams): Promise<NextableResponse<T>>`**<br>
**`next<T>(params: NextableResponse<T>): Promise<NextableResponse<T>>`** - A method that can be used
to get an initial result set in a format that can be passed directly to the same method to get the
next page. Note that the result of this call may also be used in the `prev` method to get the
previous page of results.

**`prev<T>(endpoint: string, params?: Api.Client.CollectionParams): Promise<NextableResponse<T>>`**<br>
**`prev<T>(params: NextableResponse<T>): Promise<NextableResponse<T>>`** - A method that can be used
to get an initial result set in a format that can be passed directly to the same method to get the
previous page. Note that the result of this call may also be used in the `next` method to get the
next page of results.

**`findIncluded<T>(result: Api.CollectionResponse, spec: { id: string }): T`**<br>
**`findIncluded<T>(result: Api.CollectionResponse, spec: { type: string }): Array<T>`**<br>
**`findIncluded<T>(result: Api.CollectionResponse, spec: { id: string; type: string }): T`** -
Attempt to find object(s) meeting the given spec within the `included` array of the given collection
response.


#### Type Definitions

```ts
import { HttpError } from "@wymp/http-errors";
import { Api } from "@wymp/types";

export type LoginResult = 
  | { status: "success" }
  | { status: "2fa"; code: string }
  | { status: "error"; error: HttpError };

export type NextableResponse<T = unknown> = {
  endpoint: string;
  params?: Api.Client.CollectionParams;
  response: Exclude<Api.Response<T>, Api.ErrorResponse>;
  page: Api.NextPageParams;
}
```

## Dependencies

This library was built with an attempt to include minimal depednencies. In particular, we know that
HTTP clients (fetch, axios, etc.) are both a highly personal choice and one that varies between
front- and back-end systems. For this reason, we've chosen to depend on `SimpleHttpClientInterface`
from [`@wymp/ts-simple-interfaces`](https://github.com/wymp/ts-simple-interfaces/tree/v0.5.x/packages/ts-simple-interfaces),
rather than a concrete HTTP client. This means that you will have to provide a concrete
implementation of `SimpleHttpClientInterface` on instantiation.

At the time of this writing, there are two concrete implementations:

* [SimpleHttpClientAxios](https://github.com/wymp/ts-simple-interfaces/tree/v0.5.x/packages/ts-simple-http-client-axios),
  based on the `axios` library; and
* [SimpleHttpClientRpn](https://github.com/wymp/ts-simple-interfaces/tree/v0.5.x/packages/ts-simple-http-client-rpn),
  based on the `request-promise-native` library

`SimpleHttpClientInterface` is small, and was intended to be easy to implement, so if you prefer a
different implementation, you may feel free to dress your favorite HTTP library in a wrapper that
fulfills this interface.

