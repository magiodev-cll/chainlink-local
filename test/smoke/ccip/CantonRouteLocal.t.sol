// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {CCIPLocalRouter} from "../../../src/ccip/CCIPLocalRouter.sol";
import {BasicMessageReceiver} from "../../../src/test/ccip/BasicMessageReceiver.sol";

/// @dev The EVM half of Canton to EVM: a message stamped with the Canton selector reaches a receiver
///      through the same `routeMessage` path the other chain families use.
contract CantonRouteLocalTest is Test {
    uint64 internal constant CANTON_LOCALNET_SELECTOR = 8706591216959472610;

    function testRoutesMessageFromCanton() public {
        CCIPLocalRouter router = new CCIPLocalRouter();
        BasicMessageReceiver receiver = new BasicMessageReceiver(address(router));

        bytes32 messageId = keccak256("canton-message");
        bytes memory payload = bytes("hello from canton");

        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: CANTON_LOCALNET_SELECTOR,
            sender: abi.encode(address(this)),
            data: payload,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        (bool success,,) = router.routeMessage(message, 5_000, 200_000, address(receiver));

        assertTrue(success, "route failed");
        assertEq(receiver.latestMessageId(), messageId);
        assertEq(receiver.latestSourceChainSelector(), CANTON_LOCALNET_SELECTOR);
        assertEq(receiver.latestSender(), address(this));
        assertEq(receiver.latestMessage(), payload);
    }
}
