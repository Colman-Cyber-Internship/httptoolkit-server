import _ = require('lodash');
import * as Docker from 'dockerode';
import * as semver from 'semver';
import { Mutex } from 'async-mutex';

import { DOCKER_HOST_HOSTNAME } from './docker-commands';
import { isDockerAvailable } from './docker-interception-services';

const DOCKER_TUNNEL_IMAGE = "httptoolkit/docker-socks-tunnel:v1.1.0";
const DOCKER_TUNNEL_LABEL = "tech.httptoolkit.docker.tunnel";

const getDockerTunnelContainerName = (proxyPort: number) =>
    `httptoolkit-docker-tunnel-${proxyPort}`;

// Parallel mutation of a single Docker container's state is asking for trouble, so we use
// a simple lock over all operations (across all proxes, not per-proxy, just for simplicity/safety).
const containerMutex = new Mutex();

// Starts pulling the docker tunnel image, just to ensure it's available if we need it.
export async function prepareDockerTunnel() {
    if (!await isDockerAvailable()) return;

    await containerMutex.runExclusive(async () => {
        const docker = new Docker();
        await docker.pull(DOCKER_TUNNEL_IMAGE).catch(console.warn);
    });
}

// Fully check that the container is created, up & running, recreating it if not.
// This does *not* connect any networks, so most usage will need to connect up the
// networks with updateTunnelledNetworks afterwards.
export async function ensureDockerTunnelRunning(proxyPort: number) {
    await containerMutex.runExclusive(async () => {
        const docker = new Docker();

        // Make sure we have the image available (should've been pre-pulled, but just in case)
        if (!await docker.getImage(DOCKER_TUNNEL_IMAGE).inspect().catch(() => false)) {
            await docker.pull(DOCKER_TUNNEL_IMAGE);
        }

        // Ensure we have a ready-to-use container here:
        const containerName = getDockerTunnelContainerName(proxyPort);
        let container = await docker.getContainer(containerName)
            .inspect().catch(() => undefined);
        if (!container) {
            const versionData = await docker.version();
            const engineVersion = semver.coerce(versionData.Version) || '0.0.0';

            const defaultBridgeGateway = await docker.listNetworks({
                filters: JSON.stringify({
                    driver: ['bridge'],
                    type: ['builtin']
                })
            }).then(([builtinBridge]) =>
                builtinBridge?.IPAM?.Config?.[0].Gateway
            );

            await docker.createContainer({
                name: containerName,
                Image: DOCKER_TUNNEL_IMAGE,
                Labels: {
                    [DOCKER_TUNNEL_LABEL]: String(proxyPort)
                },
                HostConfig: {
                    AutoRemove: true,
                    ...(process.platform === 'linux' ? {
                        ExtraHosts: [
                            // Make sure the host hostname is defined (not set by default on Linux).
                            // We use the host-gateway address on engines where that's possible, or
                            // the default Docker bridge host IP when it's not, because we're always
                            // connected to that network.
                            `${DOCKER_HOST_HOSTNAME}:${
                                semver.satisfies(engineVersion, '>= 20.10')
                                    ? 'host-gateway'
                                    : defaultBridgeGateway || '172.17.0.1'
                            }`
                            // (This doesn't reuse getDockerHostIp, since the logic is slightly
                            // simpler  and we never have container metadata/network state).
                        ]
                    } : {}),
                    PortBindings: {
                        '1080/tcp': [{
                            // Bind host-locally only: we don't want to let remote clients
                            // tunnel directly to any Docker container they like. Of course
                            // we expose HTTP access via the proxy, but that's at least
                            // fully visible & quite limited.
                            HostIp: '127.0.0.1'
                            // No port specified - Docker will choose any free port
                        }]
                    }
                },
            });
            container = await docker.getContainer(containerName).inspect();
        }

        // Make sure the tunneling container is running:
        if (!container.State.Running) {
            await docker.getContainer(container.Id).start();
        }
    });
}

// Update the containers network connections. If the container isn't running, this
// will automatically run ensureDockerTunnelRunning to bring it back up.
export async function updateDockerTunnelledNetworks(
    proxyPort: number,
    interceptedNetworks: string[]
) {
    const docker = new Docker();

    const defaultBridgeId = docker.listNetworks({
        filters: JSON.stringify({
            driver: ['bridge'],
            type: ['builtin']
        })
    }).then(([builtinBridge]) => builtinBridge?.Id);

    const containerName = getDockerTunnelContainerName(proxyPort);
    await docker.getContainer(containerName).inspect().catch(() =>
        ensureDockerTunnelRunning(proxyPort)
    );

    await containerMutex.runExclusive(async () => {
        // Inspect() must happen inside the lock to avoid any possible races.
        let container = await docker.getContainer(containerName).inspect();

        const expectedNetworks = _.uniq([
            ...interceptedNetworks,
            // We must always stay connected to the default bridge, to ensure that we
            // always have connectivity to the host via the default bridge gateway:
            await defaultBridgeId
        ]);

        const currentNetworks = Object.values(container.NetworkSettings.Networks)
            .map((network) => network.NetworkID);

        const missingNetworks = expectedNetworks
            .filter((network) => !currentNetworks.includes(network));

        const extraNetworks = currentNetworks
            .filter((network) => !expectedNetworks.includes(network));

        await Promise.all([
            ...missingNetworks.map(async (network) =>
                await docker.getNetwork(network)
                    .connect({ Container: container!.Id })
            ),
            ...extraNetworks.map(async (network) =>
                await docker.getNetwork(network)
                    .disconnect({ Container: container!.Id })
            ),
        ]);
    });
}

export async function getDockerTunnelPort(proxyPort: number): Promise<number> {
    const docker = new Docker();

    const containerName = getDockerTunnelContainerName(proxyPort);
    let container = await docker.getContainer(containerName)
        .inspect().catch(() => undefined);
    if (!container) {
        // Can't get the container - recreate it first, then continue.
        await ensureDockerTunnelRunning(proxyPort);
        container = await docker.getContainer(containerName).inspect();
    }

    const portMappings = container.NetworkSettings.Ports['1080/tcp'];
    const localPort = _.find(portMappings, ({ HostIp }) => HostIp === '127.0.0.1');
    if (!localPort) throw new Error("No port mapped for Docker tunnel");
    return parseInt(localPort.HostPort, 10);
}

export async function stopDockerTunnel(proxyPort: number | 'all'): Promise<void> {
    const docker = new Docker();

    containerMutex.runExclusive(async () => {
        const containers = await docker.listContainers({
            all: true,
            filters: JSON.stringify({
                label: [
                    proxyPort === 'all'
                    ? DOCKER_TUNNEL_LABEL
                    : `${DOCKER_TUNNEL_LABEL}=${proxyPort}`
                ]
            })
        });

        await Promise.all(containers.map(async (containerData) => {
            const container = docker.getContainer(containerData.Id);
            await container.kill().catch(() => {});
            await container.remove().catch(() => {});
        }));
    });
}