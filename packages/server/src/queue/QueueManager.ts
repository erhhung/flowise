import { BaseQueue } from './BaseQueue'
import { PredictionQueue } from './PredictionQueue'
import { UpsertQueue } from './UpsertQueue'
import { ScheduleQueue } from './ScheduleQueue'
import { IComponentNodes } from '../Interface'
import { Telemetry } from '../utils/telemetry'
import { CachePool } from '../CachePool'
import { DataSource } from 'typeorm'
import { Redis, Cluster } from 'ioredis'
import { AbortControllerPool } from '../AbortControllerPool'
import { QueueEventsProducer, ConnectionOptions } from 'bullmq'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { Express } from 'express'
import { UsageCacheManager } from '../UsageCacheManager'
import { ExpressAdapter } from '@bull-board/express'
import { IdentityManager } from '../IdentityManager'
import logger from '../utils/logger'

const QUEUE_NAME = process.env.QUEUE_NAME || 'flowise-queue'

type QUEUE_TYPE = 'prediction' | 'upsert' | 'schedule'

export class QueueManager {
    private static instance: QueueManager
    private queues: Map<string, BaseQueue> = new Map()
    private connection: ConnectionOptions
    private bullBoardRouter?: Express
    private predictionQueueEventsProducer?: QueueEventsProducer

    private constructor() {
        let client: Redis | Cluster
        if (!process.env.REDIS_URL) {
            const redisNode = {
                port: parseInt(process.env.REDIS_PORT || '6379'),
                host: process.env.REDIS_HOST || 'localhost',
            }
            const sslEnabled = process.env.REDIS_TLS === 'true'
            const tlsOptions = sslEnabled ? {
                tls: {
                    rejectUnauthorized: false,
                    cert: process.env.REDIS_CERT ? Buffer.from(process.env.REDIS_CERT, 'base64') : undefined,
                    key: process.env.REDIS_KEY ? Buffer.from(process.env.REDIS_KEY, 'base64') : undefined,
                    ca: process.env.REDIS_CA ? Buffer.from(process.env.REDIS_CA, 'base64') : undefined,
                }
            } : {}
            const redisOptions = {
                username: process.env.REDIS_USERNAME || undefined,
                password: process.env.REDIS_PASSWORD || undefined,
                maxRetriesPerRequest: null, // required by bullmq
                enableReadyCheck: true,
                keepAlive:
                    process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                        ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                        : undefined,
                ...tlsOptions
            }
            const clusterMode = process.env.REDIS_CLUSTER === 'true'
            logger.info(
                `[QueueManager] Connecting to Redis${clusterMode ? ' Cluster' : ''} using host:port: ${
                    process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`
            )
            if (clusterMode) {
                client = new Cluster(
                    [redisNode],
                    {redisOptions},
                )
            } else {
                client = new Redis({
                    ...redisNode,
                    ...redisOptions,
                })
            }
        } else {
            logger.info(
                `[QueueManager] Connecting to Redis using URL: ${process.env.REDIS_URL.replace(/\/\/[^:]+:[^@]+@/, '//[CREDENTIALS]@')}`
            )
            client = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null, // required by bullmq
                enableReadyCheck: true,
                keepAlive:
                    process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                        ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                        : undefined
            })
        }
        // bullmq ConnectionOptions can be options object or client instance:
        // https://api.docs.bullmq.io/types/v5.ConnectionOptions.html
        this.connection = client as ConnectionOptions;
    }

    public static getInstance(): QueueManager {
        if (!QueueManager.instance) {
            QueueManager.instance = new QueueManager()
        }
        return QueueManager.instance
    }

    public registerQueue(name: string, queue: BaseQueue) {
        this.queues.set(name, queue)
    }

    public getConnection(): ConnectionOptions {
        return this.connection
    }

    public getQueue(name: QUEUE_TYPE): BaseQueue {
        const queue = this.queues.get(name)
        if (!queue) throw new Error(`Queue ${name} not found`)
        return queue
    }

    public getPredictionQueueEventsProducer(): QueueEventsProducer {
        if (!this.predictionQueueEventsProducer) throw new Error('Prediction queue events producer not found')
        return this.predictionQueueEventsProducer
    }

    public getBullBoardRouter(): Express {
        if (!this.bullBoardRouter) throw new Error('BullBoard router not found')
        return this.bullBoardRouter
    }

    public async getAllJobCounts(): Promise<{ [queueName: string]: { [status: string]: number } }> {
        const counts: { [queueName: string]: { [status: string]: number } } = {}

        for (const [name, queue] of this.queues) {
            counts[name] = await queue.getJobCounts()
        }

        return counts
    }

    public setupAllQueues({
        componentNodes,
        telemetry,
        cachePool,
        appDataSource,
        abortControllerPool,
        usageCacheManager,
        identityManager,
        serverAdapter
    }: {
        componentNodes: IComponentNodes
        telemetry: Telemetry
        cachePool: CachePool
        appDataSource: DataSource
        abortControllerPool: AbortControllerPool
        usageCacheManager: UsageCacheManager
        identityManager: IdentityManager
        serverAdapter?: ExpressAdapter
    }) {
        const predictionQueueName = `${QUEUE_NAME}-prediction`
        const predictionQueue = new PredictionQueue(predictionQueueName, this.connection, {
            componentNodes,
            telemetry,
            cachePool,
            appDataSource,
            abortControllerPool,
            usageCacheManager
        })
        this.registerQueue('prediction', predictionQueue)

        this.predictionQueueEventsProducer = new QueueEventsProducer(predictionQueue.getQueueName(), {
            connection: this.connection
        })

        const upsertionQueueName = `${QUEUE_NAME}-upsertion`
        const upsertionQueue = new UpsertQueue(upsertionQueueName, this.connection, {
            componentNodes,
            telemetry,
            cachePool,
            appDataSource,
            usageCacheManager
        })
        this.registerQueue('upsert', upsertionQueue)

        const scheduleQueueName = `${QUEUE_NAME}-schedule`
        const scheduleQueue = new ScheduleQueue(scheduleQueueName, this.connection, {
            componentNodes,
            telemetry,
            cachePool,
            appDataSource,
            usageCacheManager,
            identityManager
        })
        this.registerQueue('schedule', scheduleQueue)

        if (serverAdapter) {
            createBullBoard({
                queues: [
                    new BullMQAdapter(predictionQueue.getQueue()),
                    new BullMQAdapter(upsertionQueue.getQueue()),
                    new BullMQAdapter(scheduleQueue.getQueue())
                ],
                serverAdapter: serverAdapter
            })
            this.bullBoardRouter = serverAdapter.getRouter()
        }
    }
}
