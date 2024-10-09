import { ServiceSignatureType } from '../../proto/api'
import { ServiceSignatureProvider } from '@reclaimprotocol/witness-sdk'
import { SOL_SIGNATURE_PROVIDER } from './solana'

export const SIGNATURES = {
	[ServiceSignatureType.SERVICE_SIGNATURE_TYPE_SOL]: SOL_SIGNATURE_PROVIDER,
} as { [key in ServiceSignatureType]: ServiceSignatureProvider }

export const SelectedServiceSignatureType = ServiceSignatureType.SERVICE_SIGNATURE_TYPE_SOL

export const SelectedServiceSignature = SIGNATURES[SelectedServiceSignatureType]