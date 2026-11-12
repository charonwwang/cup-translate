FROM fedora:44
COPY candidate.rpm /tmp/cup-candidate.rpm
RUN rpm -qp --requires /tmp/cup-candidate.rpm > /tmp/cup-requires && \
    cat /tmp/cup-requires && \
    grep -Fq 'libwebkit2gtk-4.1.so.0' /tmp/cup-requires && \
    ! grep -Fq 'libwebkit2gtk-4.0' /tmp/cup-requires && \
    dnf -y --setopt=install_weak_deps=False install /tmp/cup-candidate.rpm \
        curl dbus-daemon shadow-utils xdotool xorg-x11-server-Xvfb && \
    rpm -q cup-translate && \
    rm /tmp/cup-candidate.rpm /tmp/cup-requires && dnf clean all && \
    useradd --create-home cup-smoke
COPY launch.sh /usr/local/bin/launch-cup-smoke
USER cup-smoke
ENV HOME=/home/cup-smoke
ENTRYPOINT ["dbus-run-session", "--", "bash", "/usr/local/bin/launch-cup-smoke"]
