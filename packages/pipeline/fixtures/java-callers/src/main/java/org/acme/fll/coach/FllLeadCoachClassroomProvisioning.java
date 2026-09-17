package org.acme.fll.coach;

import java.util.List;
import java.util.stream.Collectors;
import org.acme.model.Event;

public class FllLeadCoachClassroomProvisioning {
    public List<String> k2Bands(List<String> bands) {
        boolean hasK2 = bands.stream().anyMatch(Event::isGradeBandLabelK2Only);
        if (!hasK2) {
            return List.of();
        }
        return bands.stream()
                .filter(Event::isGradeBandLabelK2Only)
                .collect(Collectors.toList());
    }
}
