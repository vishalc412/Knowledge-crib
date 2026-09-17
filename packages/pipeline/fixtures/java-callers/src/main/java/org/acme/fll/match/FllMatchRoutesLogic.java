package org.acme.fll.match;

import java.util.List;
import org.acme.model.FllEvent;

public class FllMatchRoutesLogic {
    private FllEvent event;

    public boolean useK2Rules() {
        if (event.isFllGradeBandK2Only()) {
            return true;
        }
        return false;
    }

    public long countK2(List<FllEvent> events) {
        return events.stream().filter(e -> e.isFllGradeBandK2Only()).count();
    }
}
