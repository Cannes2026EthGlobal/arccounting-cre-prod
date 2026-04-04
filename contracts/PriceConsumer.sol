// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * =============================================================================
 * PriceConsumer — receives ETH/USD price from a CRE workflow
 * =============================================================================
 *
 * HOW THIS CONTRACT GETS CALLED:
 *
 *   CRE Workflow (WASM on DON)
 *       └── evmClient.writeReport(report, { address: THIS_CONTRACT })
 *               │
 *               ▼
 *       KeystoneForwarder (Chainlink)
 *           1. Verifies DON node signatures on the report
 *           2. Checks BFT quorum (2/3+ nodes signed)
 *           3. Calls this contract: onReport(metadata, report)
 *               │
 *               ▼
 *       onReport() — inherited from ReceiverTemplate
 *           1. Checks msg.sender == forwarderAddress (security)
 *           2. Calls _processReport(report) — our logic below
 *               │
 *               ▼
 *       _processReport() — OUR CODE
 *           - Decodes: uint256 price = abi.decode(report, (uint256))
 *           - Stores it: s_ethPrice = price
 *           - Emits: PriceUpdated(price)
 *
 * SECURITY MODEL:
 *   - Only the KeystoneForwarder can call onReport() (checked by ReceiverTemplate)
 *   - The Forwarder only calls us after verifying DON signatures
 *   - So s_ethPrice is ONLY ever set by a DON-consensus result — not by any EOA
 *
 * =============================================================================
 */

// ReceiverTemplate is provided by Chainlink. It:
//   - Implements IReceiver (the onReport interface)
//   - Validates that only the trusted Forwarder can call onReport()
//   - Calls _processReport() after validation passes
import {ReceiverTemplate} from "./ReceiverTemplate.sol";

contract PriceConsumer is ReceiverTemplate {
    // ETH/USD price scaled to 8 decimals.
    // e.g. 324157000000 means $3241.57
    // To get real price: s_ethPrice / 1e8
    uint256 public s_ethPrice;

    // When was the price last updated
    uint256 public s_lastUpdated;

    event PriceUpdated(uint256 newPrice, uint256 timestamp);

    /**
     * @param _forwarderAddress The KeystoneForwarder contract address.
     *   For simulation (Sepolia): 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
     *   For production (Sepolia): 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
     *
     * This address is the ONLY one allowed to call onReport() on this contract.
     * If someone else tries to call it directly, ReceiverTemplate reverts.
     */
    constructor(address _forwarderAddress) ReceiverTemplate(_forwarderAddress) {}

    /**
     * @dev Called by ReceiverTemplate.onReport() after signature verification.
     * @param report ABI-encoded uint256 price (8 decimals)
     *
     * In the workflow (TypeScript):
     *   const encoded = encodeAbiParameters(parseAbiParameters('uint256'), [priceBigInt])
     *   const report  = runtime.report(encoded).result()
     *   evmClient.writeReport(runtime, report, { address: consumerAddress })
     */
    function _processReport(bytes calldata report) internal override {
        // Decode the uint256 price from the ABI-encoded report bytes
        uint256 newPrice = abi.decode(report, (uint256));

        s_ethPrice = newPrice;
        s_lastUpdated = block.timestamp;

        emit PriceUpdated(newPrice, block.timestamp);
    }

    /**
     * @notice Returns the ETH price as a human-readable string (for convenience).
     * @return price in USD with 8 decimal places of precision
     */
    function getPrice() external view returns (uint256 price, uint256 updatedAt) {
        return (s_ethPrice, s_lastUpdated);
    }
}
