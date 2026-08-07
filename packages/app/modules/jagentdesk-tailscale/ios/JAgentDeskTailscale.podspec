Pod::Spec.new do |s|
  s.name = 'JAgentDeskTailscale'
  s.version = '0.1.0'
  s.summary = 'Embedded Tailscale transport for JAgentDesk'
  s.license = 'BSD-3-Clause'
  s.author = 'JAgentDesk'
  s.homepage = 'https://jagentdesk.local'
  s.platforms = { :ios => '13.4' }
  s.swift_version = '5.4'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.vendored_frameworks = 'TailscaleBridgeNative.xcframework'
  # Keep generated Go framework headers out of CocoaPods' umbrella header.
  # The xcframework already exports those headers through its own module map.
  s.source_files = '*.swift'
end
