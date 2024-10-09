export enum ServiceSignatureType {
    SERVICE_SIGNATURE_TYPE_UNKNOWN = 0,
    /**
     * SERVICE_SIGNATURE_TYPE_ETH - ETH keys & signature
     * keys: secp256k1
     * signature: ethereum flavor of ECDSA (https://goethereumbook.org/signature-generate/)
     */

    SERVICE_SIGNATURE_TYPE_SOL = 1,
    UNRECOGNIZED = -1,
  }