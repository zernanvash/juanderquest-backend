import { id } from 'ethers';
import { env } from '../config/env.js';

/**
 * Plan 50: deterministic on-chain identity for an achievement award.
 * The same award always maps to the same entitlement and token id, so a retry
 * can never mint a second badge (the contract also rejects a used entitlement).
 */
export function badgeEntitlement(awardId: string): string {
  return id(`jdq:badge:v1:${awardId}`);
}

/** uint256 token id as a decimal string (NUMERIC(78,0) in chain_commands). */
export function badgeTokenId(awardId: string): string {
  return BigInt(id(`jdq:badge-token:v1:${awardId}`)).toString();
}

export function badgeTokenUri(tokenId: string): string {
  return `${env.PUBLIC_API_BASE.replace(/\/+$/, '')}/api/v1/chain/badges/${tokenId}`;
}

const TOKEN_ID = /^(0|[1-9][0-9]{0,77})$/;
export const isBadgeTokenId = (value: string): boolean => TOKEN_ID.test(value);
