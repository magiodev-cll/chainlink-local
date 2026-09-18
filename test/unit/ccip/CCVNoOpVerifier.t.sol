// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {CCVNoOpVerifier, ICCVNoOpVerifierFork} from "../../../src/test/ccip/CCVNoOpVerifier.sol";

/// @dev Unit coverage for the fork-only no-op CCV: it resolves to itself, never reverts verification
///      and charges no fee.
contract CCVNoOpVerifierTest is Test {
    CCVNoOpVerifier internal verifier;

    function setUp() public {
        verifier = new CCVNoOpVerifier();
    }

    function test_ResolversReturnSelf() public view {
        assertEq(verifier.getInboundImplementation(""), address(verifier));
        assertEq(verifier.getOutboundImplementation(1, ""), address(verifier));
    }

    function test_SupportsVerifierAndERC165Interfaces() public view {
        assertTrue(verifier.supportsInterface(type(ICCVNoOpVerifierFork).interfaceId));
        assertTrue(verifier.supportsInterface(0x01ffc9a7));
        assertFalse(verifier.supportsInterface(0xdeadbeef));
    }

    function test_FeeIsZero() public view {
        ICCVNoOpVerifierFork.EVM2AnyMessage memory message;
        (uint16 feeUSDCents, uint32 gasForVerification, uint32 payloadSizeBytes) =
            verifier.getFee(1, message, "", bytes4(0));
        assertEq(feeUSDCents, 0);
        assertEq(gasForVerification, 0);
        assertEq(payloadSizeBytes, 0);
    }

    function test_VerifyMessageIsNoOp() public {
        ICCVNoOpVerifierFork.MessageV1 memory message;
        verifier.verifyMessage(message, bytes32(0), "");
    }

    function test_StorageLocations() public view {
        string[] memory locations = verifier.getStorageLocations();
        assertEq(locations.length, 1);
        assertEq(locations[0], "mock://ccv");
    }
}
