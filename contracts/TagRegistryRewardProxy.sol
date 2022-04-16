/**
 * @authors: [@greenlucid]
 * @reviewers: []
 * @auditors: []
 * @bounties: []
 * @deployments: []
 * SPDX-License-Identifier: Licenses are not real
 */

pragma solidity ^0.8.11;

// Actually unused.
// Idea would've been, this contract would be used to publicly broadcast rewards.
// But turns out we don't need to remember who we reward.
// Still it may be good to build upon, in case we decide to migrate later
// Also it means PNK to distribute isn't held in an EOA.

/**
 * @title Tag Registry Reward Proxy
 * @author green
 * @notice Relays rewards alongside an event, to link reward and tagged address
 */