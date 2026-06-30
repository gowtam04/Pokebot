import Foundation

// Response DTOs for the `/api/auth/*` endpoints (api-design.md "Auth").
//
// These auth payloads are already **camelCase on the wire** (`signedIn`,
// `expiresAt`) — the documented "mixed conventions" case (data-model.md): they
// are NOT snake_case, so the explicit `CodingKeys` map identity keys and no
// global `.convertFromSnakeCase` is used. All three are response-only (`Decodable`)
// value types and `Sendable` (they cross the `OakAPIClient` actor boundary).

/// `POST /api/auth/verify` success body (`web/src/app/api/auth/verify/route.ts`).
///
/// `token` is the additive Bearer-auth field (ADR-2 / api-design.md "Change 2"):
/// the raw session token the client stores in the Keychain and sends as
/// `Authorization: Bearer`. `expiresAt` is the epoch-ms expiry of the 30-day
/// session window — the route returns it even though the doc tables omit it, and
/// the TS source is authoritative. Only the 200 success path returns this shape;
/// failures decode as `APIErrorBody`.
struct AuthVerifyResponse: Decodable, Sendable {
  let ok: Bool
  let email: String
  let created: Bool
  let token: String
  let expiresAt: Int64

  enum CodingKeys: String, CodingKey {
    case ok
    case email
    case created
    case token
    case expiresAt
  }
}

/// `GET /api/auth/me` body (`web/src/app/api/auth/me/route.ts`).
///
/// `{ signedIn: true, email }` for a resolved account, `{ signedIn: false }` for
/// a guest (no `email`) — always 200, never an error (a guest is a first-class
/// value, not a failure), so `email` is optional.
struct MeResponse: Decodable, Sendable {
  let signedIn: Bool
  let email: String?

  enum CodingKeys: String, CodingKey {
    case signedIn
    case email
  }
}

/// The shared `{ code, message }` error envelope returned by non-2xx responses
/// (`web/src/app/api/auth/_lib/http.ts` `jsonError`).
///
/// `status` is NOT part of the JSON body — the HTTP status line carries it — so
/// it decodes as `nil` from the wire; it is an optional slot the networking layer
/// fills from the response when mapping to `OakError`.
struct APIErrorBody: Decodable, Sendable {
  let code: String
  let message: String
  let status: Int?

  enum CodingKeys: String, CodingKey {
    case code
    case message
    case status
  }
}
