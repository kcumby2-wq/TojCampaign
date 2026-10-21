import UIKit
import Capacitor

/// The Capacitor web view, plus the app's own plugin for the Share inbox.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedInboxPlugin())
    }
}
