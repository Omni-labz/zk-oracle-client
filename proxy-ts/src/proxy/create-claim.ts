import { strToUint8Array, TLSPacketContext } from '@reclaimprotocol/tls'
import { makeRpcTlsTunnel } from '@reclaimprotocol/witness-sdk/lib/tunnels/make-rpc-tls-tunnel'
import { getWitnessClientFromPool } from '@reclaimprotocol/witness-sdk'
import { DEFAULT_HTTPS_PORT } from '@reclaimprotocol/witness-sdk/lib/config'
import { ClaimTunnelRequest, ZKProofEngine } from '@reclaimprotocol/witness-sdk/lib/proto/api'
import { providers } from '@reclaimprotocol/witness-sdk/lib/providers'
import { CompleteTLSPacket, CreateClaimOnWitnessOpts, IWitnessClient, MessageRevealInfo, ProviderName, Transcript } from '@reclaimprotocol/witness-sdk/lib/types'
import { canonicalStringify, generateTunnelId, getBlocksToReveal, getProviderValue, isApplicationData, logger as LOGGER, makeHttpResponseParser, redactSlices, unixTimestampSeconds, WitnessError } from '@reclaimprotocol/witness-sdk/lib/utils'
import { preparePacketsForReveal } from "./utils/prepare-packets"
import { generateProof, verifyProof, makeLocalSnarkJsZkOperator } from '@reclaimprotocol/circom-symmetric-crypto'
import { executeWithRetries } from '@reclaimprotocol/witness-sdk/lib/utils/retries'
import { SIGNATURES } from '@reclaimprotocol/witness-sdk'
import { getDefaultTlsOptions } from '@reclaimprotocol/witness-sdk/lib/utils/tls'

type ServerAppDataPacket = {
	plaintext: Uint8Array
	message: TLSPacketContext
}

/**
 * Create a claim on a witness server
 */

export function createClaimOnWitness<N extends ProviderName>(
	{ logger: _logger, ...opts }: CreateClaimOnWitnessOpts<N>
) {
	const logger = _logger
		// if the client has already been initialised
		// and no logger is provided, use the client's logger
		// otherwise default to the global logger
		|| ('logger' in opts.client ? opts.client.logger : LOGGER)
	return executeWithRetries(
		attempt => (
			_createClaimOnWitness<N>({
				...opts,
				logger: attempt
					? logger.child({ attempt })
					: logger
			})
		),
		{ logger, shouldRetry }
	)
}

function shouldRetry(err: Error) {
	if(err instanceof TypeError) {
		return false
	}

	return err instanceof WitnessError
		&& err.code !== 'WITNESS_ERROR_INVALID_CLAIM'
		&& err.code !== 'WITNESS_ERROR_BAD_REQUEST'
}

async function _createClaimOnWitness<N extends ProviderName>(
	{
		name,
		params,
		secretParams,
		context,
		onStep,
		ownerPrivateKey,
		client: clientInit,
		logger = LOGGER,
		timestampS,
		...zkOpts
	}: CreateClaimOnWitnessOpts<N>
) {
	const provider = providers[name]
	const hostPort = getProviderValue(params, provider.hostPort)
	const geoLocation = getProviderValue(params, provider.geoLocation)
	const providerTlsOpts = getProviderValue(
		params,
		provider.additionalClientOptions
	)
	const tlsOpts = {
		...getDefaultTlsOptions(),
		...providerTlsOpts,
	}

	let redactionMode = getProviderValue(params, provider.writeRedactionMode)

	const [host, port] = hostPort.split(':')
	const resParser = makeHttpResponseParser()

	let client: IWitnessClient
	let lastMsgRevealed = false

	const revealMap = new Map<TLSPacketContext, MessageRevealInfo>()

	onStep?.({ name: 'connecting' })

	let endedHttpRequest: ((err?: Error) => void) | undefined
	const createTunnelReq = {
		host,
		port: port ? +port : DEFAULT_HTTPS_PORT,
		geoLocation,
		id: generateTunnelId()
	}

	const tunnel = await makeRpcTlsTunnel({
		tlsOpts,
		connect: (initMessages) => {
			let created = false
			if('metadata' in clientInit) {
				client = clientInit
			} else {
				client = getWitnessClientFromPool(
					clientInit.url,
					() => {
						created = true
						return { initMessages, logger }
					}
				)
			}

			if(!created) {
				client
					.waitForInit()
					.then(() => client.sendMessage(...initMessages))
					.catch(err => {
						logger.error(
							{ err },
							'error in sending init msgs'
						)
					})
			}

			return client
		},
		logger,
		request: createTunnelReq,
		onMessage(data) {
			logger.debug({ bytes: data.length }, 'recv data from server')

			resParser.onChunk(data)
			if(resParser.res.complete) {
				logger?.debug('got complete HTTP response from server')
				// wait a little bit to make sure the client has
				// finished writing the response
				setTimeout(() => {
					endedHttpRequest?.()
				}, 100)
			}
		},
		onClose(err) {
			const level = err ? 'error' : 'debug'
			logger?.[level]({ err }, 'tls session ended')
			endedHttpRequest?.(err)
			try {
				resParser.streamEnded()
			} catch{ }
		},
	})
	const {
		version: tlsVersion,
		cipherSuite
	} = tunnel.tls.getMetadata()
	if(tlsVersion === 'TLS1_2' && redactionMode !== 'zk') {
		redactionMode = 'zk'
		logger.info('TLS1.2 detected, defaulting to zk redaction mode')
	}

	const {
		redactions,
		data: requestStr
	} = provider.createRequest(
		// @ts-ignore
		secretParams,
		params
	)
	const requestData = typeof requestStr === 'string'
		? strToUint8Array(requestStr)
		: requestStr

	logger.debug(
		{ redactions: redactions.length },
		'generated request'
	)

	const waitForAllData = new Promise<void>(
		(resolve, reject) => {
			endedHttpRequest = err => (
				err ? reject(err) : resolve()
			)
		}
	)

	onStep?.({ name: 'sending-request-data' })

	try {
		if(redactionMode === 'zk') {
			await writeRedactedZk()
		} else {
			await writeRedactedWithKeyUpdate()
		}

		logger.info('wrote request to server')
	} catch(err) {
		// wait for complete stream end when the session is closed
		// mid-write, as this means the server could not process
		// our request due to some error. Hope the stream end
		// error will be more descriptive
		logger.error(
			{ err },
			'session errored during write, waiting for stream end'
		)
	}

	onStep?.({ name: 'waiting-for-response' })

	await waitForAllData
	await tunnel.close()

	logger.info('got full response from server')

	const signatureAlg = SIGNATURES[client!.metadata.signatureType]

	// now that we have the full transcript, we need
	// to generate the ZK proofs & send them to the witness
	// to verify & sign our claim
	const claimTunnelReq = ClaimTunnelRequest.create({
		request: createTunnelReq,
		data: {
			provider: name,
			parameters: canonicalStringify(params),
			context: canonicalStringify(context),
			timestampS: timestampS ?? unixTimestampSeconds(),
			owner: getAddress(),
		},
		transcript: await generateTranscript(),
		zkEngine: zkOpts.zkEngine ? (zkOpts.zkEngine === 'snarkJS' ? ZKProofEngine.ZK_ENGINE_SNARKJS : ZKProofEngine.ZK_ENGINE_GNARK) : ZKProofEngine.ZK_ENGINE_SNARKJS,

	})

	onStep?.({ name: 'waiting-for-verification' })

	const claimTunnelBytes = ClaimTunnelRequest
		.encode(claimTunnelReq).finish()
	const requestSignature = await signatureAlg
		.sign(claimTunnelBytes, ownerPrivateKey)
	claimTunnelReq.signatures = { requestSignature }

	const result = await client!.rpc('claimTunnel', claimTunnelReq)

	logger.info(
		{ success: !!result.claim },
		'recv claim response from witness'
	)

	return result // Return the ZK proof along with the result

	async function writeRedactedWithKeyUpdate() {
		let currentIndex = 0
		for(const section of redactions) {
			const block = requestData
				.slice(currentIndex, section.fromIndex)
			if(block.length) {
				await writeWithReveal(block, true)
			}

			const redacted = requestData
				.slice(section.fromIndex, section.toIndex)
			await writeWithReveal(redacted, false)
			currentIndex = section.toIndex
		}

		// write if redactions were there
		const lastBlockStart = redactions?.[redactions.length - 1]
			?.toIndex || 0
		const block = requestData.slice(lastBlockStart)
		if(block.length) {
			await writeWithReveal(block, true)
		}
	}

	async function writeRedactedZk() {
		await tunnel.tls.write(requestData)
		setRevealOfLastSentBlock(
			{
				type: 'zk',
				redactedPlaintext: redactSlices(requestData, redactions)
			}
		)
	}

	/**
	 * Write data to the tunnel, with the option to mark the packet
	 * as revealable to the witness or not
	 */
	async function writeWithReveal(data: Uint8Array, reveal: boolean) {
		// if the reveal state has changed, update the traffic keys
		// to not accidentally reveal a packet not meant to be revealed
		// and vice versa
		if(reveal !== lastMsgRevealed) {
			await tunnel.tls.updateTrafficKeys()
		}

		await tunnel.write(data)
		// now we mark the packet to be revealed to the witness
		setRevealOfLastSentBlock(reveal ? { type: 'complete' } : undefined)
		lastMsgRevealed = reveal
	}

	function setRevealOfLastSentBlock(
		reveal: MessageRevealInfo | undefined
	) {
		const lastBlock = getLastBlock('client')
		if(!lastBlock) {
			return
		}

		setRevealOfMessage(lastBlock.message, reveal)
	}

	function getLastBlock(sender: 'client' | 'server') {
		// set the correct index for the server blocks
		for(let i = tunnel.transcript.length - 1;i >= 0;i--) {
			const block = tunnel.transcript[i]
			if(block.sender === sender) {
				return block
			}
		}
	}

	/**
	 * Generate transcript with reveal data for the witness to verify
	 */
	async function generateTranscript() {
		addServerSideReveals()

		const startMs = Date.now()
		const revealedMessages = await preparePacketsForReveal(
			tunnel.transcript,
			revealMap,
			{
				logger,
				cipherSuite: cipherSuite!,
				onZkProgress(done, total) {
					const timeSinceStartMs = Date.now() - startMs
					const timePerBlockMs = timeSinceStartMs / done
					const timeLeftMs = timePerBlockMs * (total - done)
					onStep?.({
						name: 'generating-zk-proofs',
						proofsDone: done,
						proofsTotal: total,
						approxTimeLeftS: Math.round(timeLeftMs / 1000),
					})
				},
				...zkOpts,
			}
		)

		return revealedMessages
	}

	/**
	 * Add reveals for server side blocks, using
	 * the provider's redaction function if available.
	 * Otherwise, opts to reveal all server side blocks.
	 */
	function addServerSideReveals() {
		const allPackets = tunnel.transcript
		let serverPacketsToReveal: ReturnType<typeof getBlocksToReveal<ServerAppDataPacket>> = 'all'

		const packets: Transcript<Uint8Array> = []
		const serverBlocks: ServerAppDataPacket[] = []
		for(const b of allPackets) {
			if(b.message.type !== 'ciphertext'
				|| !isApplicationData(b.message, tlsVersion)
			) {
				continue
			}

			const plaintext = tlsVersion === 'TLS1_3'
				? b.message.plaintext.slice(0, -1)
				: b.message.plaintext

			packets.push({
				message: plaintext,
				sender:b.sender
			})

			if(b.sender === 'server') {
				serverBlocks.push({
					plaintext:plaintext,
					message: b.message
				})
			}
		}

		provider.assertValidProviderReceipt(packets, {
			...params,
			secretParams:secretParams //provide secret params for proper request body validation
		})

		if(provider.getResponseRedactions) {
			serverPacketsToReveal = getBlocksToReveal(
				serverBlocks,
				total => provider.getResponseRedactions!(
					total,
					params
				)
			)
		}

		if(serverPacketsToReveal === 'all') {
			// reveal all server side blocks
			for(const { message, sender } of allPackets) {
				if(sender === 'server') {
					setRevealOfMessage(message, { type: 'complete' })
				}
			}
		} else {
			for(const { block, redactedPlaintext } of serverPacketsToReveal) {
				setRevealOfMessage(block.message, {
					type: 'zk',
					redactedPlaintext
				})
			}
		}

		// reveal all handshake blocks
		// so the witness can verify there was no
		// hanky-panky
		for(const p of allPackets) {
			if(p.message.type !== 'ciphertext') {
				continue
			}

			// break the moment we hit the first
			// application data packet
			if(isApplicationData(p.message, tlsVersion)) {
				break
			}

			if(redactionMode === 'zk') {
				setRevealOfMessage(p.message, {
					type: 'zk',
					redactedPlaintext: p.message.plaintext
				})
			} else {
				setRevealOfMessage(p.message, { type: 'complete' })
			}
		}
	}

	function setRevealOfMessage(message: TLSPacketContext, reveal: MessageRevealInfo | undefined) {
		if(reveal) {
			revealMap.set(message, reveal)
			return
		}

		revealMap.delete(message)
	}

	async function generateTLSSessionProof(transcript: Buffer, secretKey: Buffer) {
		const algorithm = 'chacha20' // Assuming ChaCha20 for TLS 1.3
		const iv = new Uint8Array(transcript.slice(0, 12)) // Assuming IV is first 12 bytes
		const ciphertext = transcript.slice(12)
	
		const operator = await makeLocalSnarkJsZkOperator(algorithm)
	
		return await generateProof({
			algorithm,
			privateInput: {
				key: secretKey,
			},
			publicInput: {
				ciphertext,
				iv,
				offset: 0
			},
			operator,
		})
	}

	function getAddress() {
		const {
			getAddress,
			getPublicKey,
		} = signatureAlg
		const pubKey = getPublicKey(ownerPrivateKey)
		return getAddress(pubKey)
	}

	function getCiphertextFromTranscript(transcript: Transcript<CompleteTLSPacket>): Uint8Array {
		// Combine all application data packets into a single Uint8Array
		const allData = transcript
			.filter(packet => packet.message.type === 'ciphertext')
			.map(packet => packet.message.data)
	
		// Concatenate all the Uint8Arrays
		const totalLength = allData.reduce((sum, arr) => sum + arr.length, 0)
		const result = new Uint8Array(totalLength)
		let offset = 0
		for (const arr of allData) {
			result.set(arr, offset)
			offset += arr.length
		}
	
		return result
	}

	function convertTranscriptToBuffer(transcript: Transcript<CompleteTLSPacket>): Buffer {
		// Combine all packet data into a single Buffer
		const allData = transcript.map(packet => packet.message.data)
		return Buffer.concat(allData)
	}
}