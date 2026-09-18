// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Register} from "./Register.sol";
import {Internal} from "@chainlink/contracts-ccip/contracts/libraries/Internal.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "../vendor/openzeppelin-solidity/v4.8.3/contracts/token/ERC20/IERC20.sol";

/// @title IRouterFork Interface
interface IRouterFork {
    /**
     * @notice Structure representing an offRamp configuration
     *
     * @param sourceChainSelector - The chain selector for the source chain
     * @param offRamp - The address of the offRamp contract
     */
    struct OffRamp {
        uint64 sourceChainSelector;
        address offRamp;
    }

    /**
     * @notice Return the configured onramp for specific a destination chain.
     *  @param destChainSelector The destination chain Id to get the onRamp for.
     * @return The address of the onRamp.
     */
    function getOnRamp(uint64 destChainSelector) external view returns (address);

    /**
     * @notice Gets the list of offRamps
     *
     * @return offRamps - Array of OffRamp structs
     */
    function getOffRamps() external view returns (OffRamp[] memory);
}

/// @title IEVM2EVMOffRampFork Interface
interface IEVM2EVMOffRampFork {
    /**
     * @notice Executes a single CCIP message on the offRamp
     *
     * @param message - The CCIP message to be executed
     * @param offchainTokenData - Additional offchain token data
     */
    function executeSingleMessage(
        Internal.Any2EVMRampMessage memory message,
        bytes[] calldata offchainTokenData,
        uint32[] calldata tokenGasOverrides
    ) external;
}

interface InternalPreV1dot6 {
    struct EVM2EVMMessage {
        uint64 sourceChainSelector; // ────────╮ the chain selector of the source chain, note: not chainId
        address sender; // ────────────────────╯ sender address on the source chain
        address receiver; // ──────────────────╮ receiver address on the destination chain
        uint64 sequenceNumber; // ─────────────╯ sequence number, not unique across lanes
        uint256 gasLimit; //                     user supplied maximum gas amount available for dest chain execution
        bool strict; // ───────────────────────╮ DEPRECATED
        uint64 nonce; //                       │ nonce for this lane for this sender, not unique across senders/lanes
        address feeToken; // ──────────────────╯ fee token
        uint256 feeTokenAmount; //               fee token amount
        bytes data; //                           arbitrary data payload supplied by the message sender
        Client.EVMTokenAmount[] tokenAmounts; // array of tokens and amounts to transfer
        bytes[] sourceTokenData; //              array of token data, one per token
        bytes32 messageId; //                    a hash of the message data
    }
}

interface IEVM2EVMOffRampPreV1dot6Fork {
    function executeSingleMessage(
        InternalPreV1dot6.EVM2EVMMessage memory message,
        bytes[] memory offchainTokenData,
        uint32[] memory tokenGasOverrides
    ) external;
}

/// @title IEVM2EVMOffRampStaticConfigFork
/// @notice Minimal view surface for pre-v1.6 OffRamp static config (EVM2EVMOffRamp 1.5.x).
interface IEVM2EVMOffRampStaticConfigFork {
    struct StaticConfig {
        address commitStore;
        uint64 chainSelector;
        uint64 sourceChainSelector;
        address onRamp;
        address prevOffRamp;
        address rmnProxy;
        address tokenAdminRegistry;
    }

    function getStaticConfig() external view returns (StaticConfig memory);
}

/// @title IOffRampSourceConfigFork
/// @notice Minimal view surface for v1.6+ OffRamp per-source-chain config (OffRamp 1.6.x).
/// @dev `router` is ABI-compatible with `IRouter` in CCIP OffRamp `SourceChainConfig`.
interface IOffRampSourceConfigFork {
    struct SourceChainConfig {
        address router;
        bool isEnabled;
        uint64 minSeqNr;
        bool isRMNVerificationDisabled;
        bytes onRamp;
    }

    function getSourceChainConfig(uint64 sourceChainSelector) external view returns (SourceChainConfig memory);
}

/// @title IOffRampV2Fork Interface
/// @notice Minimal mirror of the CCIP 2.0 OffRamp execution surface. `execute` is permissionless and
///         takes the opaque `encodedMessage` emitted by the source OnRamp; `getCCVsForMessage`
///         derives the CCV list required to execute a captured message.
interface IOffRampV2Fork {
    function execute(
        bytes calldata encodedMessage,
        address[] calldata ccvs,
        bytes[] calldata verifierResults,
        uint32 gasLimitOverride
    ) external;

    function getCCVsForMessage(bytes calldata encodedMessage)
        external
        view
        returns (address[] memory requiredCCVs, address[] memory optionalCCVs, uint8 threshold);
}

/// @title IOffRampSourceConfigV2Fork Interface
/// @notice Minimal view/update surface for the CCIP 2.0 OffRamp per-source-chain config, including
///         the CCV sets used to verify messages. Mirrors `OffRamp.SourceChainConfig`.
interface IOffRampSourceConfigV2Fork {
    struct SourceChainConfig {
        address router;
        bool isEnabled;
        bytes[] onRamps;
        address[] defaultCCVs;
        address[] laneMandatedCCVs;
    }

    struct SourceChainConfigArgs {
        address router;
        uint64 sourceChainSelector;
        bool isEnabled;
        bytes[] onRamps;
        address[] defaultCCVs;
        address[] laneMandatedCCVs;
    }

    function getSourceChainConfig(uint64 sourceChainSelector) external view returns (SourceChainConfig memory);

    function applySourceChainConfigUpdates(SourceChainConfigArgs[] calldata updates) external;

    function owner() external view returns (address);
}

/// @title ICcipMessageSentV2Fork Interface
/// @notice CCIP 2.0 OnRamp `CCIPMessageSent` event shape. The full message travels as an opaque
///         `encodedMessage` that the destination OffRamp executes permissionlessly.
interface ICcipMessageSentV2Fork {
    struct Receipt {
        address issuer;
        uint32 destGasLimit;
        uint32 destBytesOverhead;
        uint256 feeTokenAmount;
        bytes extraArgs;
    }

    event CCIPMessageSent(
        uint64 indexed destChainSelector,
        address indexed sender,
        bytes32 indexed messageId,
        address feeToken,
        uint256 tokenAmountBeforeTokenPoolFees,
        bytes encodedMessage,
        Receipt[] receipts,
        bytes[] verifierBlobs
    );
}

/// @title CCIPLocalSimulatorFork
/// @notice Works with Foundry only
contract CCIPLocalSimulatorFork is Test {
    /**
     * @notice Events emitted when a CCIP send request is made
     */
    event CCIPSendRequested(InternalPreV1dot6.EVM2EVMMessage message);
    event CCIPMessageSent(
        uint64 indexed destChainSelector, uint64 indexed sequenceNumber, Internal.EVM2AnyRampMessage message
    );

    error InvalidExtraArgsTag();

    error InvalidEVMAddressEncoding(bytes encodedAddress);

    uint32 public constant DEFAULT_GAS_LIMIT = 200_000;

    /// @notice The immutable register instance
    Register immutable i_register;

    /// @notice The address of the LINK faucet
    address constant LINK_FAUCET = 0x4281eCF07378Ee595C564a59048801330f3084eE;

    /// @notice Mapping to track processed messages
    mapping(bytes32 messageId => bool isProcessed) internal s_processedMessages;

    /**
     * @notice Constructor to initialize the contract
     */
    constructor() {
        vm.recordLogs();
        i_register = new Register();
        vm.makePersistent(address(i_register));
    }

    /**
     * @notice  To be called after the sending of the cross-chain message (`ccipSend`).
     *          Goes through the list of past logs and looks for the `CCIPSendRequested` and `CCIPMessageSent` events.
     *          Switches to a destination network fork. Routes the sent cross-chain message on the destination network.
     *          If you sent more than one message, it will try to route all of them to `forkId`.
     *
     * @param forkId - The ID of the destination network fork. This is the returned value of `createFork()` or `createSelectFork()`
     */
    function switchChainAndRouteMessage(uint256 forkId) external {
        uint256 sourceForkId = vm.activeFork();
        address sourceRouterAddress = i_register.getNetworkDetails(block.chainid).routerAddress;

        uint256[] memory forkIds = new uint256[](1);
        forkIds[0] = forkId;

        _routeCapturedMessages(forkIds, sourceForkId, sourceRouterAddress);
    }

    /**
     * @notice  To be called after the sending of the cross-chain message (`ccipSend`).
     *          Override variant of the `switchChainAndRouteMessage(uint256 forkId)` function in case of multiple destination forks.
     *          Goes through the list of past logs and looks for the `CCIPSendRequested` and `CCIPMessageSent` events.
     *          Loops through provided `forkIds` and tries to route the message to correct destination.
     *          If you haven't provide correct `forkId`, the message will get lost.
     *          If you sent more than one message, it will try to route all of them to correct destinations.
     *
     * @param forkIds - The IDs of the destination network forks. These are the returned values of `createFork()` or `createSelectFork()`
     */
    function switchChainAndRouteMessage(uint256[] memory forkIds) external {
        uint256 sourceForkId = vm.activeFork();
        address sourceRouterAddress = i_register.getNetworkDetails(block.chainid).routerAddress;

        _routeCapturedMessages(forkIds, sourceForkId, sourceRouterAddress);
    }

    /**
     * @notice Returns the default values for currently CCIP supported networks. If network is not present or some of the values are changed, user can manually add new network details using the `setNetworkDetails` function.
     *
     * @param chainId - The blockchain network chain ID. For example 11155111 for Ethereum Sepolia. Not CCIP chain selector.
     *
     * @return networkDetails - The tuple containing:
     *          chainSelector - The unique CCIP Chain Selector.
     *          routerAddress - The address of the CCIP Router contract.
     *          linkAddress - The address of the LINK token.
     *          wrappedNativeAddress - The address of the wrapped native token that can be used for CCIP fees.
     *          ccipBnMAddress - The address of the CCIP BnM token.
     *          ccipLnMAddress - The address of the CCIP LnM token.
     */
    function getNetworkDetails(uint256 chainId) external view returns (Register.NetworkDetails memory) {
        return i_register.getNetworkDetails(chainId);
    }

    /**
     * @notice If network details are not present or some of the values are changed, user can manually add new network details using the `setNetworkDetails` function.
     *
     * @param chainId - The blockchain network chain ID. For example 11155111 for Ethereum Sepolia. Not CCIP chain selector.
     * @param networkDetails - The tuple containing:
     *          chainSelector - The unique CCIP Chain Selector.
     *          routerAddress - The address of the CCIP Router contract.
     *          linkAddress - The address of the LINK token.
     *          wrappedNativeAddress - The address of the wrapped native token that can be used for CCIP fees.
     *          ccipBnMAddress - The address of the CCIP BnM token.
     *          ccipLnMAddress - The address of the CCIP LnM token.
     */
    function setNetworkDetails(uint256 chainId, Register.NetworkDetails memory networkDetails) external {
        i_register.setNetworkDetails(chainId, networkDetails);
    }

    /**
     * @notice Returns the destination OffRamp configured for `sourceOnRamp` on the given fork, if
     *         discoverable. Useful to configure CCIP 2.0 lane CCVs before routing a message.
     *
     * @param forkId - The ID of the destination network fork.
     * @param sourceChainSelector - The chain selector of the source chain.
     * @param sourceOnRamp - The address of the OnRamp on the source chain.
     *
     * @return offRamp - The matching OffRamp address, or address(0) when not found.
     */
    function getOffRampForLane(uint256 forkId, uint64 sourceChainSelector, address sourceOnRamp)
        external
        returns (address offRamp)
    {
        uint256 previousForkId = vm.activeFork();
        vm.selectFork(forkId);
        IRouterFork.OffRamp[] memory offRamps =
            IRouterFork(i_register.getNetworkDetails(block.chainid).routerAddress).getOffRamps();
        offRamp = _findOffRampForLaneV2(offRamps, sourceChainSelector, sourceOnRamp);
        vm.selectFork(previousForkId);
    }

    /**
     * @notice Points a destination lane's default CCVs at `ccv` by impersonating the OffRamp owner.
     *         Fork-only testing helper for CCIP 2.0 lanes: the mocked CCV must be configured on the
     *         destination lane before a captured message can be routed through the permissionless
     *         execution path. Router, enabled flag and OnRamp bindings are preserved.
     *
     * @param forkId - The ID of the destination network fork.
     * @param offRamp - The destination OffRamp that holds the lane config.
     * @param sourceChainSelector - The chain selector of the source chain.
     * @param ccv - The CCV address to set as the lane default.
     */
    function setLaneDefaultCCVs(uint256 forkId, address offRamp, uint64 sourceChainSelector, address ccv) external {
        uint256 previousForkId = vm.activeFork();
        vm.selectFork(forkId);

        IOffRampSourceConfigV2Fork.SourceChainConfig memory current =
            IOffRampSourceConfigV2Fork(offRamp).getSourceChainConfig(sourceChainSelector);
        require(current.isEnabled, "CCIPLocalSimulatorFork: lane not enabled");

        address[] memory defaultCCVs = new address[](1);
        defaultCCVs[0] = ccv;

        IOffRampSourceConfigV2Fork.SourceChainConfigArgs[] memory updates =
            new IOffRampSourceConfigV2Fork.SourceChainConfigArgs[](1);
        updates[0] = IOffRampSourceConfigV2Fork.SourceChainConfigArgs({
            router: current.router,
            sourceChainSelector: sourceChainSelector,
            isEnabled: true,
            onRamps: current.onRamps,
            defaultCCVs: defaultCCVs,
            laneMandatedCCVs: new address[](0)
        });

        address owner = IOffRampSourceConfigV2Fork(offRamp).owner();
        vm.startPrank(owner);
        IOffRampSourceConfigV2Fork(offRamp).applySourceChainConfigUpdates(updates);
        vm.stopPrank();

        vm.selectFork(previousForkId);
    }

    /**
     * @notice Requests LINK tokens from the faucet. The provided amount of tokens are transferred to provided destination address.
     *
     * @param to - The address to which LINK tokens are to be sent.
     * @param amount - The amount of LINK tokens to send.
     *
     * @return success - Returns `true` if the transfer of tokens was successful, otherwise `false`.
     */
    function requestLinkFromFaucet(address to, uint256 amount) external returns (bool success) {
        address linkAddress = i_register.getNetworkDetails(block.chainid).linkAddress;

        vm.startPrank(LINK_FAUCET);
        success = IERC20(linkAddress).transfer(to, amount);
        vm.stopPrank();
    }

    /**
     * @notice Internal function to route captured messages to their respective destination forks.
     *
     * @param forkIds - The IDs of the destination network forks. These are the returned values of `createFork()` or `createSelectFork()`, not chainIds.
     * @param sourceForkId - The ID of the source network fork. This is the returned value of `createFork()` or `createSelectFork()`, not chainId.
     * @param sourceRouterAddress - The address of the Router on the source chain.
     */
    function _routeCapturedMessages(uint256[] memory forkIds, uint256 sourceForkId, address sourceRouterAddress)
        internal
    {
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 logsLength = entries.length;

        for (uint256 i; i < logsLength; ++i) {
            // Try Routing pre v1.6 message
            if (entries[i].topics[0] == CCIPSendRequested.selector) {
                InternalPreV1dot6.EVM2EVMMessage memory message =
                    abi.decode(entries[i].data, (InternalPreV1dot6.EVM2EVMMessage));

                if (!s_processedMessages[message.messageId]) {
                    for (uint256 j; j < forkIds.length; ++j) {
                        vm.selectFork(forkIds[j]);
                        uint64 destinationChainSelector = i_register.getNetworkDetails(block.chainid).chainSelector;

                        vm.selectFork(sourceForkId);
                        address onRampContract = IRouterFork(sourceRouterAddress).getOnRamp(destinationChainSelector);

                        // Deliver message
                        if (entries[i].emitter == onRampContract) {
                            vm.selectFork(forkIds[j]);

                            IRouterFork.OffRamp[] memory offRamps =
                                IRouterFork(i_register.getNetworkDetails(block.chainid).routerAddress).getOffRamps();
                            uint256 offRampsLength = offRamps.length;

                            address matchedOffRamp =
                                _findOffRampForOnRamp(offRamps, message.sourceChainSelector, onRampContract);
                            bool routed = false;
                            if (matchedOffRamp != address(0)) {
                                routed = _executePreV1dot6(matchedOffRamp, message);
                            }
                            if (!routed) {
                                for (uint256 k = offRampsLength; k > 0; --k) {
                                    if (offRamps[k - 1].sourceChainSelector != message.sourceChainSelector) {
                                        continue;
                                    }
                                    if (matchedOffRamp != address(0) && offRamps[k - 1].offRamp == matchedOffRamp) {
                                        continue;
                                    }
                                    if (_executePreV1dot6(offRamps[k - 1].offRamp, message)) {
                                        routed = true;
                                        break;
                                    }
                                }
                            }
                            if (routed) {
                                s_processedMessages[message.messageId] = true;
                            }
                        }
                    }
                }
            }

            // Try Routing post v1.6 message
            if (entries[i].topics[0] == CCIPMessageSent.selector) {
                Internal.EVM2AnyRampMessage memory message = abi.decode(entries[i].data, (Internal.EVM2AnyRampMessage));

                if (!s_processedMessages[message.header.messageId]) {
                    for (uint256 j; j < forkIds.length; ++j) {
                        vm.selectFork(forkIds[j]);
                        uint64 destinationChainSelector = i_register.getNetworkDetails(block.chainid).chainSelector;

                        vm.selectFork(sourceForkId);
                        address onRampContract = IRouterFork(sourceRouterAddress).getOnRamp(destinationChainSelector);

                        // Deliver message
                        if (entries[i].emitter == onRampContract) {
                            vm.selectFork(forkIds[j]);

                            IRouterFork.OffRamp[] memory offRamps =
                                IRouterFork(i_register.getNetworkDetails(block.chainid).routerAddress).getOffRamps();
                            uint256 offRampsLength = offRamps.length;

                            address matchedOffRamp =
                                _findOffRampForOnRamp(offRamps, message.header.sourceChainSelector, onRampContract);
                            bool routed = false;
                            if (matchedOffRamp != address(0)) {
                                routed = _executePostV1dot6(matchedOffRamp, message);
                            }
                            if (!routed) {
                                for (uint256 k = offRampsLength; k > 0; --k) {
                                    if (offRamps[k - 1].sourceChainSelector != message.header.sourceChainSelector) {
                                        continue;
                                    }
                                    if (matchedOffRamp != address(0) && offRamps[k - 1].offRamp == matchedOffRamp) {
                                        continue;
                                    }
                                    if (_executePostV1dot6(offRamps[k - 1].offRamp, message)) {
                                        routed = true;
                                        break;
                                    }
                                }
                            }
                            if (routed) {
                                s_processedMessages[message.header.messageId] = true;
                            }
                        }
                    }
                }
            }

            // Try Routing CCIP 2.0 message
            if (entries[i].topics[0] == ICcipMessageSentV2Fork.CCIPMessageSent.selector) {
                bytes32 messageId = bytes32(entries[i].topics[3]);
                uint64 messageDestChainSelector = uint64(uint256(entries[i].topics[1]));
                (,, bytes memory encodedMessage,,) =
                    abi.decode(entries[i].data, (address, uint256, bytes, ICcipMessageSentV2Fork.Receipt[], bytes[]));

                if (!s_processedMessages[messageId]) {
                    for (uint256 j; j < forkIds.length; ++j) {
                        vm.selectFork(forkIds[j]);
                        uint64 destinationChainSelector = i_register.getNetworkDetails(block.chainid).chainSelector;

                        vm.selectFork(sourceForkId);
                        address onRampContract = IRouterFork(sourceRouterAddress).getOnRamp(destinationChainSelector);

                        // Deliver message
                        if (
                            destinationChainSelector == messageDestChainSelector && entries[i].emitter == onRampContract
                        ) {
                            vm.selectFork(forkIds[j]);

                            IRouterFork.OffRamp[] memory offRamps =
                                IRouterFork(i_register.getNetworkDetails(block.chainid).routerAddress).getOffRamps();
                            uint256 offRampsLength = offRamps.length;

                            bool routed = false;
                            for (uint256 k = offRampsLength; k > 0; --k) {
                                if (_executeV2(offRamps[k - 1].offRamp, encodedMessage)) {
                                    routed = true;
                                    break;
                                }
                            }
                            if (routed) {
                                s_processedMessages[messageId] = true;
                            }
                        }
                    }
                }
            }
        }
    }

    /// @notice Returns the CCIP 2.0 OffRamp whose lane binds `sourceOnRamp` for `sourceChainSelector`.
    /// @dev Candidates are probed with low-level calls because the router lists OffRamps of several
    ///      protocol versions; probing a missing selector or decoding a mismatched config payload
    ///      must never revert the routing flow.
    function _findOffRampForLaneV2(
        IRouterFork.OffRamp[] memory offRamps,
        uint64 sourceChainSelector,
        address sourceOnRamp
    ) internal view returns (address offRampAddress) {
        uint256 length = offRamps.length;
        for (uint256 i = length; i > 0; --i) {
            address candidate = offRamps[i - 1].offRamp;
            if (offRamps[i - 1].sourceChainSelector != sourceChainSelector) {
                continue;
            }

            (bool ok, bytes memory data) = candidate.staticcall(
                abi.encodeWithSelector(IOffRampSourceConfigV2Fork.getSourceChainConfig.selector, sourceChainSelector)
            );
            if (!ok || data.length == 0) {
                continue;
            }

            (bool decoded, IOffRampSourceConfigV2Fork.SourceChainConfig memory cfg) = _decodeSourceChainConfigV2(data);
            if (!decoded || !cfg.isEnabled) {
                continue;
            }

            for (uint256 j; j < cfg.onRamps.length; ++j) {
                if (cfg.onRamps[j].length == 32 && abi.decode(cfg.onRamps[j], (address)) == sourceOnRamp) {
                    return candidate;
                }
            }
        }

        return address(0);
    }

    /// @notice Decodes a 2.0 `SourceChainConfig` return payload without reverting the caller.
    /// @dev The decode runs in an external self-call so an incompatible candidate payload (e.g. a
    ///      1.6 OffRamp reply) fails inside the try/catch instead of the calling frame.
    function _decodeSourceChainConfigV2(bytes memory data)
        internal
        view
        returns (bool ok, IOffRampSourceConfigV2Fork.SourceChainConfig memory cfg)
    {
        try this.decodeSourceChainConfigV2(data) returns (IOffRampSourceConfigV2Fork.SourceChainConfig memory decoded) {
            return (true, decoded);
        } catch {
            return (false, cfg);
        }
    }

    /// @notice External decode helper for `_decodeSourceChainConfigV2`. Do not call directly.
    function decodeSourceChainConfigV2(bytes calldata data)
        external
        pure
        returns (IOffRampSourceConfigV2Fork.SourceChainConfig memory)
    {
        return abi.decode(data, (IOffRampSourceConfigV2Fork.SourceChainConfig));
    }

    /// @notice Returns the destination OffRamp whose lane is configured for `sourceOnRamp`, if discoverable.
    function _findOffRampForOnRamp(
        IRouterFork.OffRamp[] memory offRamps,
        uint64 sourceChainSelector,
        address sourceOnRamp
    ) internal view returns (address offRampAddress) {
        uint256 length = offRamps.length;
        for (uint256 i = length; i > 0; --i) {
            address candidateAddr = offRamps[i - 1].offRamp;
            if (offRamps[i - 1].sourceChainSelector != sourceChainSelector) {
                continue;
            }

            try IOffRampSourceConfigFork(candidateAddr).getSourceChainConfig(sourceChainSelector) returns (
                IOffRampSourceConfigFork.SourceChainConfig memory cfg
            ) {
                if (cfg.isEnabled && cfg.onRamp.length == 32) {
                    address configuredOnRamp = abi.decode(cfg.onRamp, (address));
                    if (configuredOnRamp == sourceOnRamp) {
                        return candidateAddr;
                    }
                }
            } catch {}

            try IEVM2EVMOffRampStaticConfigFork(candidateAddr).getStaticConfig() returns (
                IEVM2EVMOffRampStaticConfigFork.StaticConfig memory staticCfg
            ) {
                if (staticCfg.onRamp == sourceOnRamp && staticCfg.sourceChainSelector == sourceChainSelector) {
                    return candidateAddr;
                }
            } catch {}
        }

        return address(0);
    }

    function _executePreV1dot6(address offRamp, InternalPreV1dot6.EVM2EVMMessage memory message)
        internal
        returns (bool success)
    {
        uint256 numberOfTokens = message.tokenAmounts.length;
        bytes[] memory offchainTokenData = new bytes[](numberOfTokens);
        uint32[] memory tokenGasOverrides = new uint32[](numberOfTokens);
        for (uint256 l; l < numberOfTokens; ++l) {
            tokenGasOverrides[l] = uint32(message.gasLimit);
        }

        vm.startPrank(offRamp);
        try IEVM2EVMOffRampPreV1dot6Fork(offRamp).executeSingleMessage(message, offchainTokenData, tokenGasOverrides) {
            vm.stopPrank();
            return true;
        } catch (bytes memory err) {
            vm.stopPrank();
            console2.logBytes(err);
            return false;
        }
    }

    function _executePostV1dot6(address offRamp, Internal.EVM2AnyRampMessage memory message)
        internal
        returns (bool success)
    {
        uint256 gasLimit = _fromBytes(message.extraArgs).gasLimit;
        uint256 numberOfTokens = message.tokenAmounts.length;
        Internal.Any2EVMTokenTransfer[] memory tokenAmounts = new Internal.Any2EVMTokenTransfer[](numberOfTokens);
        for (uint256 l; l < numberOfTokens; ++l) {
            tokenAmounts[l] = Internal.Any2EVMTokenTransfer({
                sourcePoolAddress: abi.encode(message.tokenAmounts[l].sourcePoolAddress),
                destTokenAddress: _decodeEVMAddress(message.tokenAmounts[l].destTokenAddress),
                destGasAmount: abi.decode(message.tokenAmounts[l].destExecData, (uint32)),
                extraData: message.tokenAmounts[l].extraData,
                amount: message.tokenAmounts[l].amount
            });
        }
        Internal.Any2EVMRampMessage memory any2EVMRampMessage = Internal.Any2EVMRampMessage({
            header: message.header,
            sender: abi.encodePacked(message.sender),
            data: message.data,
            receiver: _decodeEVMAddress(message.receiver),
            gasLimit: gasLimit,
            tokenAmounts: tokenAmounts
        });
        bytes[] memory offchainTokenData = new bytes[](numberOfTokens);
        uint32[] memory tokenGasOverrides = new uint32[](numberOfTokens);
        for (uint256 l; l < numberOfTokens; ++l) {
            tokenGasOverrides[l] = uint32(gasLimit);
        }

        vm.startPrank(offRamp);
        try IEVM2EVMOffRampFork(offRamp)
            .executeSingleMessage(any2EVMRampMessage, offchainTokenData, tokenGasOverrides) {
            vm.stopPrank();
            return true;
        } catch (bytes memory err) {
            vm.stopPrank();
            console2.logBytes(err);
            return false;
        }
    }

    /**
     * @notice Attempts permissionless execution of a CCIP 2.0 message on `offRamp`, deriving the CCV
     *         list required for the message from the OffRamp itself. Returns false when the OffRamp
     *         does not know the message's source lane or when execution reverts, so the caller can
     *         fall back to another candidate OffRamp.
     *
     * @param offRamp - The destination OffRamp to attempt execution on.
     * @param encodedMessage - The opaque CCIP 2.0 message emitted by the source OnRamp.
     */
    function _executeV2(address offRamp, bytes memory encodedMessage) internal returns (bool success) {
        // Low-level call: an OffRamp of an older protocol version does not expose the selector and
        // returns empty data instead of a decodable result.
        (bool ok, bytes memory data) =
            offRamp.staticcall(abi.encodeWithSelector(IOffRampV2Fork.getCCVsForMessage.selector, encodedMessage));
        if (!ok || data.length == 0) {
            return false;
        }

        (address[] memory requiredCCVs,,) = abi.decode(data, (address[], address[], uint8));

        bytes[] memory verifierResults = new bytes[](requiredCCVs.length);
        try IOffRampV2Fork(offRamp).execute(encodedMessage, requiredCCVs, verifierResults, 0) {
            return true;
        } catch (bytes memory err) {
            console2.logBytes(err);
            return false;
        }
    }

    /**
     * @notice Decodes ABI-encoded EVM address bytes to an `address`.
     * @dev Used for `Client.EVM2AnyMessage.receiver` and `Internal.EVM2AnyTokenTransfer.destTokenAddress`.
     *      CCIP uses `abi.encode(address)` (32 bytes). A legacy 20-byte packed representation is also supported.
     */
    function _decodeEVMAddress(bytes memory encodedAddress) internal pure returns (address) {
        if (encodedAddress.length == 32) {
            return abi.decode(encodedAddress, (address));
        }
        if (encodedAddress.length == 20) {
            return address(uint160(bytes20(encodedAddress)));
        }
        revert InvalidEVMAddressEncoding(encodedAddress);
    }

    /**
     * @notice Internal helper function to decode extraArgs bytes to GenericExtraArgsV2 struct.
     *         Supports decoding of both GenericExtraArgsV2 and EVMExtraArgsV1 structs.
     *
     * @param extraArgs - The bytes representing the extra arguments.
     *
     * @return genericExtraArgs - The decoded GenericExtraArgsV2 struct.
     */
    function _fromBytes(bytes memory extraArgs) internal pure returns (Client.GenericExtraArgsV2 memory) {
        if (extraArgs.length == 0) {
            return Client.GenericExtraArgsV2({gasLimit: DEFAULT_GAS_LIMIT, allowOutOfOrderExecution: false});
        }

        bytes4 extraArgsTag = bytes4(extraArgs);
        bytes memory gasLimit = new bytes(extraArgs.length - 4);
        for (uint256 i = 4; i < extraArgs.length; ++i) {
            gasLimit[i - 4] = extraArgs[i];
        }

        if (extraArgsTag == Client.GENERIC_EXTRA_ARGS_V2_TAG) {
            return abi.decode(gasLimit, (Client.GenericExtraArgsV2));
        } else if (extraArgsTag == Client.EVM_EXTRA_ARGS_V1_TAG) {
            return
                Client.GenericExtraArgsV2({gasLimit: abi.decode(gasLimit, (uint256)), allowOutOfOrderExecution: false});
        }

        revert InvalidExtraArgsTag();
    }
}
