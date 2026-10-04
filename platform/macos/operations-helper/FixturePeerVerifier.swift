// FixturePeerVerifier.swift — FIXTURE ONLY.
//
// This file is documentation/fixture evidence for the native-channel peer
// contract. It is NOT referenced by any Xcode target, Swift package, or CI
// build step, and MUST NOT be added to one without an approved production
// Team ID (currently NOT SUPPLIED — production signing stays BLOCKED).
//
// Mirrors src/peer-verifier.ts: TeamID + bundle allowlist, synthetic example
// uid (exampleOpsUID OPERATIONS / exampleCodingUID CODING — SYNTHETIC ONLY,
// never production config; real UID-role binding comes from target-Mac
// account discovery at WP-20), audit-session binding. FAILS CLOSED on
// adhoc ("adhoc", "-", empty) and unknown signers.
//
// NOTE: No SecCodeCopySigningInformation / real codesign is performed here.

import Foundation

enum FixturePeerVerifierError: Error {
    case adhocSigner(String)
    case unknownSigner(teamID: String, bundleID: String)
    case unknownUID(Int)
    case missingAuditSession
    case productionBlocked
}

/// Production Team ID has NOT been supplied: always throws.
func assertProductionUnblocked() throws -> Never {
    throw FixturePeerVerifierError.productionBlocked
}

struct FixtureSigner: Equatable {
    let teamID: String
    let bundleID: String
}

/// Synthetic example UIDs — fixture only, never production config.
let exampleOpsUID = 502
let exampleCodingUID = 503

struct FixturePeer {
    let uid: Int
    let teamID: String
    let bundleID: String
    let auditSessionID: String
}

func verifyPeerFixture(_ peer: FixturePeer, fixtureSigners: [FixtureSigner]) throws {
    let adhocIDs = ["", "adhoc", "-"]
    if adhocIDs.contains(peer.teamID) {
        throw FixturePeerVerifierError.adhocSigner(peer.teamID)
    }
    let known = fixtureSigners.contains { $0.teamID == peer.teamID && $0.bundleID == peer.bundleID }
    if !known {
        throw FixturePeerVerifierError.unknownSigner(teamID: peer.teamID, bundleID: peer.bundleID)
    }
    if peer.uid != exampleOpsUID && peer.uid != exampleCodingUID {
        throw FixturePeerVerifierError.unknownUID(peer.uid)
    }
    if peer.auditSessionID.isEmpty {
        throw FixturePeerVerifierError.missingAuditSession
    }
}
